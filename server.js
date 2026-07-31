const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let charterBookings = []; // 包場 [{ id, date, court, hour, name, phone, email }]
let pickupBookings = [];  // 接龍 [{ id, date, session, name, phone, email, timestamp }]

const PICKUP_COURT_PRIORITY = ['C', 'B', 'A', 'D']; // 接龍鎖場優先順序

const SESSION_HOURS = {
    morning: [9, 10, 11],
    afternoon: [15, 16, 17],
    evening: [19, 20, 21],
    night: [21, 22, 23]
};

// 🌟 伺服器啟動時從 Google 試算表同步載入歷史資料
async function initDataFromGoogleSheet() {
    if (!GOOGLE_SHEET_URL || GOOGLE_SHEET_URL.includes("你的GoogleScript網址")) {
        console.log("[Init] 未設定有效的 GOOGLE_SHEET_URL，跳過啟動資料載入。");
        return;
    }

    try {
        console.log("[Init] 正在從 Google 試算表載入歷史資料...");
        const res = await fetch(GOOGLE_SHEET_URL);
        const data = await res.json();

        if (data.charters && data.pickups) {
            charterBookings = data.charters;
            pickupBookings = data.pickups;
            console.log(`[Init] 成功載入 ${charterBookings.length} 筆包場與 ${pickupBookings.length} 筆接龍資料！`);
        }
    } catch (err) {
        console.error("[Init] 從 Google 試算表載入資料時發生錯誤:", err);
    }
}

// 🌟 核心計算邏輯：精準計算場地鎖定、容量與每個人的正/備取狀態
function getDayData(date) {
    const dayCharters = charterBookings.filter(b => b.date === date);
    const dayPickups = pickupBookings.filter(b => b.date === date);

    const sessionsData = {};

    ['morning', 'afternoon', 'evening', 'night'].forEach(sess => {
        const hours = SESSION_HOURS[sess];
        const list = dayPickups.filter(b => b.session === sess);
        const count = list.length;

        // 1. 檢查哪些場地在這 3 小時內已經被單獨包場
        const charteredCourtsInSession = new Set();
        hours.forEach(h => {
            dayCharters.filter(b => b.hour === h).forEach(b => charteredCourtsInSession.add(b.court));
        });

        // 2. 依照 C -> B -> A -> D 順序過濾出未被包場的可用場地
        const availCourtsForPickup = PICKUP_COURT_PRIORITY.filter(court => !charteredCourtsInSession.has(court));

        // 3. 每滿 4 人鎖定 1 個場地（最多鎖定所有可用場地）
        const lockedCourtCount = Math.min(Math.floor(count / 4), availCourtsForPickup.length);
        const lockedCourts = availCourtsForPickup.slice(0, lockedCourtCount);

        // 4. 接龍最大容量（每個可用場地 8 人）
        const maxCap = availCourtsForPickup.length * 8;

        // 5. 正取人數門檻：已成團鎖定的場地數 * 8 人
        const confirmedCapacity = lockedCourtCount * 8;

        // 6. 計算每個人的顯示標籤
        const listWithStatus = list.map((b, idx) => {
            const rank = idx + 1;
            let status = '';

            if (rank <= confirmedCapacity) {
                status = '(正取)';
            } else if (rank <= maxCap) {
                status = '(滿4人成團，尚有場地)';
            } else {
                status = '(今天所有場次已滿)';
            }

            return { ...b, rank, status };
        });

        sessionsData[sess] = {
            list: listWithStatus,
            availCourtsCount: availCourtsForPickup.length,
            lockedCourts: lockedCourts, // 已被接龍鎖定的場地 (如 ['C', 'B'])
            maxCap: maxCap,
            currentCount: count
        };
    });

    return { charters: dayCharters, sessions: sessionsData };
}

// 🌟 自動同步到 Google 試算表
async function syncToGoogleSheet(date) {
    if (!GOOGLE_SHEET_URL || GOOGLE_SHEET_URL.includes("你的GoogleScript網址")) return;

    const dayData = getDayData(date);
    const payload = {
        date: date,
        charters: dayData.charters,
        sessions: dayData.sessions
    };

    try {
        await fetch(GOOGLE_SHEET_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log(`[Google Sheet] ${date} 資料同步成功！`);
    } catch (err) {
        console.error('[Google Sheet] 同步失敗:', err);
    }
}

// 1. 取得當天資料 API
app.get('/api/all-data', (req, res) => {
    const { date } = req.query;
    res.json(getDayData(date));
});

// 2. 提交報名 API (含 10 天前開放、1 小時前截止、鎖場校驗)
app.post('/api/book', async (req, res) => {
    const { type, name, phone, email, date, court, hour, session } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ success: false, message: '姓名與電話為必填！' });
    }

    const now = new Date();
    let startTime = new Date(date);

    if (type === 'charter') {
        startTime.setHours(Number(hour), 0, 0, 0);
    } else {
        const startHours = { morning: 9, afternoon: 15, evening: 19, night: 21 };
        startTime.setHours(startHours[session], 0, 0, 0);
    }

    const diffInHours = (startTime - now) / (1000 * 60 * 60);
    const diffInDays = diffInHours / 24;

    if (diffInDays > 10) {
        return res.status(400).json({ success: false, message: '尚未開放報名！僅開放 10 天內的場次預約。' });
    }

    if (diffInHours < 1) {
        return res.status(400).json({ success: false, message: '已截止報名！活動開始前 1 小時內無法再報名。' });
    }

    const dayData = getDayData(date);
    const id = Date.now().toString();

    if (type === 'charter') {
        const h = Number(hour);
        
        // 校驗 1：是否已被包場
        const exists = dayData.charters.some(b => b.hour === h && b.court === court);
        if (exists) {
            return res.status(400).json({ success: false, message: '該場地該時段已被預約！' });
        }

        // 校驗 2：是否已被接龍鎖定 3 小時 (C -> B -> A -> D)
        let isLockedByPickup = false;
        Object.keys(SESSION_HOURS).forEach(sessKey => {
            if (SESSION_HOURS[sessKey].includes(h)) {
                if (dayData.sessions[sessKey].lockedCourts.includes(court)) {
                    isLockedByPickup = true;
                }
            }
        });

        if (isLockedByPickup) {
            return res.status(400).json({ success: false, message: `【${court}場】已被接龍報名鎖定，該 3 小時內無法進行包場預約！` });
        }

        charterBookings.push({ id, date, court, hour: h, name, phone, email: email || '' });

    } else if (type === 'pickup') {
        const sessData = dayData.sessions[session];
        if (sessData.currentCount >= sessData.maxCap) {
            return res.status(400).json({ success: false, message: '今天所有場次已滿，無法再報名！' });
        }

        pickupBookings.push({ id, date, session, name, phone, email: email || '', timestamp: new Date() });
    }

    syncToGoogleSheet(date);
    return res.json({ success: true, message: '報名成功！' });
});

// 3. 取消報名 API
app.post('/api/cancel', async (req, res) => {
    const { id, type, phone } = req.body;

    let booking = type === 'charter' 
        ? charterBookings.find(b => b.id === id) 
        : pickupBookings.find(b => b.id === id);

    if (!booking) {
        return res.status(404).json({ success: false, message: '找不到該筆報名紀錄' });
    }

    if (booking.phone !== phone) {
        return res.status(400).json({ success: false, message: '驗證失敗！電話號碼不符合，無法取消。' });
    }

    let targetTime = new Date(booking.date);
    if (type === 'charter') {
        targetTime.setHours(booking.hour, 0, 0, 0);
    } else {
        const startHours = { morning: 9, afternoon: 15, evening: 19, night: 21 };
        targetTime.setHours(startHours[booking.session], 0, 0, 0);
    }

    const now = new Date();
    const diffInHours = (targetTime - now) / (1000 * 60 * 60);

    if (diffInHours <= 1) {
        return res.status(400).json({ success: false, message: '打球前 1 小時內（或已過期）無法取消預約！' });
    }

    const bookingDate = booking.date;

    if (type === 'charter') {
        charterBookings = charterBookings.filter(b => b.id !== id);
    } else {
        pickupBookings = pickupBookings.filter(b => b.id !== id);
    }

    syncToGoogleSheet(bookingDate);
    res.json({ success: true, message: '預約已成功取消！' });
});

// 4. 管理員強制刪除 API
app.post('/api/admin-cancel', async (req, res) => {
    const { id, type, adminPassword } = req.body;

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
    }

    let booking = type === 'charter' 
        ? charterBookings.find(b => b.id === id) 
        : pickupBookings.find(b => b.id === id);

    if (booking) {
        const bookingDate = booking.date;
        if (type === 'charter') {
            charterBookings = charterBookings.filter(b => b.id !== id);
        } else {
            pickupBookings = pickupBookings.filter(b => b.id !== id);
        }
        syncToGoogleSheet(bookingDate);
    }

    res.json({ success: true, message: '【管理員操作】已成功強制刪除該筆報名！' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    await initDataFromGoogleSheet();
});
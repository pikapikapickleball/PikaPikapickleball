const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 從 Render 環境變數讀取管理員密碼，若未設定預設為 admin123
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let charterBookings = []; // 包場 [{ id, date, court, hour, name, phone, email }]
let pickupBookings = [];  // 接龍 [{ id, date, session, name, phone, email, timestamp }]

// 1. 取得當天資料 API
app.get('/api/all-data', (req, res) => {
    const { date } = req.query;

    const sessionHours = {
        morning: [9, 10, 11],
        afternoon: [15, 16, 17],
        evening: [19, 20, 21],
        night: [21, 22, 23]
    };

    const dayCharters = charterBookings.filter(b => b.date === date);
    const dayPickups = pickupBookings.filter(b => b.date === date);

    const sessionsData = {};
    ['morning', 'afternoon', 'evening', 'night'].forEach(sess => {
        const hours = sessionHours[sess];
        let maxChartered = 0;
        hours.forEach(h => {
            const count = dayCharters.filter(b => b.hour === h).length;
            if (count > maxChartered) maxChartered = count;
        });

        const availCourts = Math.max(0, 4 - maxChartered);
        const maxCap = availCourts * 8;
        const list = dayPickups.filter(b => b.session === sess);

        sessionsData[sess] = {
            list: list,
            availCourts: availCourts,
            maxCap: maxCap,
            currentCount: list.length
        };
    });

    res.json({
        charters: dayCharters,
        sessions: sessionsData
    });
});

// 2. 提交報名 API
app.post('/api/book', (req, res) => {
    const { type, name, phone, email, date, court, hour, session } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ success: false, message: '姓名與電話為必填！' });
    }

    const id = Date.now().toString();

    if (type === 'charter') {
        const h = Number(hour);
        const exists = charterBookings.some(b => b.date === date && b.court === court && b.hour === h);
        if (exists) {
            return res.status(400).json({ success: false, message: '該場地該時段已被預約！' });
        }
        charterBookings.push({ id, date, court, hour: h, name, phone, email });
        return res.json({ success: true, message: '包場成功！' });
    } else if (type === 'pickup') {
        pickupBookings.push({ id, date, session, name, phone, email, timestamp: new Date() });
        return res.json({ success: true, message: '接龍報名成功！' });
    }

    res.status(400).json({ success: false, message: '無效的報名請求' });
});

// 3. 一般使用者取消報名 API (須電話認證與1小時限制)
app.post('/api/cancel', (req, res) => {
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
        return res.status(400).json({ 
            success: false, 
            message: '打球前 1 小時內（或已過期）無法取消預約！' 
        });
    }

    if (type === 'charter') {
        charterBookings = charterBookings.filter(b => b.id !== id);
    } else {
        pickupBookings = pickupBookings.filter(b => b.id !== id);
    }

    res.json({ success: true, message: '預約已成功取消！' });
});

// 4. 管理員強制刪除 API (比對環境變數密碼，免電話驗證)
app.post('/api/admin-cancel', (req, res) => {
    const { id, type, adminPassword } = req.body;

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: '管理員密碼錯誤！' });
    }

    if (type === 'charter') {
        charterBookings = charterBookings.filter(b => b.id !== id);
    } else {
        pickupBookings = pickupBookings.filter(b => b.id !== id);
    }

    res.json({ success: true, message: '【管理員操作】已成功強制刪除該筆報名！' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
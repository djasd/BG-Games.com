const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const os = require('os');
const CDP = require('chrome-remote-interface');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Конфигурация
const CONFIG = {
    PORT: process.env.PORT || 3000,
    WS_PORT: process.env.WS_PORT || 3001,
    TOKEN: process.env.TOKEN || 'yandex-music-token',
    CDP_PORT: 9222,
    CDP_HOST: 'localhost'
};

// Статические файлы
app.use(express.static('public'));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/remote.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'remote.html'));
});

app.get('/mobile.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// API эндпоинты
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        version: '1.0.0',
        uptime: process.uptime(),
        clients: wss.clients.size,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/qr', async (req, res) => {
    try {
        const networkInfo = getNetworkInfo();
        const ip = networkInfo.localIPs.length > 0 ? networkInfo.localIPs[0].address : 'localhost';
        
        const config = {
            type: 'yandex-music-remote',
            server: `http://${ip}:${CONFIG.PORT}`,
            ws: `ws://${ip}:${CONFIG.WS_PORT}`,
            token: CONFIG.TOKEN,
            timestamp: new Date().toISOString()
        };
        
        const qrCode = await QRCode.toDataURL(JSON.stringify(config));
        
        res.json({
            qr: qrCode,
            config: config,
            url: `http://${ip}:${CONFIG.PORT}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получение сетевой информации
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const networkInfo = {
        localIPs: [],
        hostname: os.hostname()
    };
    
    Object.keys(interfaces).forEach(iface => {
        interfaces[iface].forEach(addr => {
            if (addr.family === 'IPv4' && !addr.internal) {
                networkInfo.localIPs.push({
                    interface: iface,
                    address: addr.address
                });
            }
        });
    });
    
    return networkInfo;
}

// WebSocket соединения
wss.on('connection', (ws, req) => {
    console.log('Новое WebSocket подключение');
    
    // Отправляем приветственное сообщение
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Добро пожаловать в Яндекс.Музыка управление',
        timestamp: new Date().toISOString()
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('Получено сообщение:', message);
            
            // Обработка команд
            handleCommand(ws, message);
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
            ws.send(JSON.stringify({ error: 'Неверный формат сообщения' }));
        }
    });
    
    ws.on('close', () => {
        console.log('WebSocket соединение закрыто');
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error);
    });
});

// Обработка команд
function handleCommand(ws, message) {
    const { command, data } = message;
    
    switch (command) {
        case 'ping':
            ws.send(JSON.stringify({
                type: 'pong',
                timestamp: Date.now()
            }));
            break;
            
        case 'getStatus':
            // Здесь будет код для получения статуса из Яндекс.Музыки
            const mockStatus = {
                playing: false,
                track: {
                    title: 'Трек не выбран',
                    artist: 'Исполнитель не указан',
                    album: 'Альбом не указан',
                    cover: null
                },
                volume: 70,
                muted: false,
                time: {
                    current: 0,
                    total: 180
                }
            };
            
            ws.send(JSON.stringify({
                type: 'status',
                data: mockStatus
            }));
            break;
            
        case 'control':
            // Здесь будет код для управления Яндекс.Музыкой
            console.log('Команда управления:', data);
            ws.send(JSON.stringify({
                type: 'control',
                success: true,
                command: data
            }));
            break;
            
        default:
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Неизвестная команда'
            }));
    }
}

// Запуск сервера
server.listen(CONFIG.PORT, () => {
    const networkInfo = getNetworkInfo();
    console.log('='.repeat(50));
    console.log('🎵 Яндекс.Музыка - Сервер управления');
    console.log('='.repeat(50));
    console.log(`\n🌐 Сервер запущен:`);
    console.log(`   Локально: http://localhost:${CONFIG.PORT}`);
    
    if (networkInfo.localIPs.length > 0) {
        networkInfo.localIPs.forEach(ipInfo => {
            console.log(`   Сеть: http://${ipInfo.address}:${CONFIG.PORT}`);
        });
    }
    
    console.log(`\n🔗 Основные страницы:`);
    console.log(`   Интерфейс управления: http://localhost:${CONFIG.PORT}/remote.html`);
    console.log(`   Мобильная версия: http://localhost:${CONFIG.PORT}/mobile.html`);
    console.log(`   Админ-панель: http://localhost:${CONFIG.PORT}/admin.html`);
    
    console.log(`\n📡 WebSocket: ws://localhost:${CONFIG.WS_PORT}`);
    console.log(`\n🔑 Токен: ${CONFIG.TOKEN}`);
    console.log('\n🚀 Готов к работе!');
    console.log('='.repeat(50));
});
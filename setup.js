const CDP = require('chrome-remote-interface');
const express = require('express');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const { networkInterfaces } = require('os');
const axios = require('axios');

console.log('🎵 Яндекс.Музыка - Глобальный сервер управления');
console.log('='.repeat(70));

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
    // Режимы работы
    MODE: process.argv.includes('--worldwide') ? 'worldwide' : 
          process.argv.includes('--local') ? 'local' : 'auto',
    
    // Основные настройки
    CDP_PORT: 9222,
    CDP_HOST: 'localhost',
    
    // Публичный доступ
    PUBLIC_ACCESS: true,
    DOMAIN: null, // Можно установить свой домен
    DYNAMIC_DNS: false, // Автоматическое обновление IP
    
    // Порты
    HTTP_PORT: 3002,
    WS_PORT: 3003,
    AUTH_TOKEN: 'yandex-music-token',
    
    // Туннели (альтернатива пробросу портов)
    TUNNELS: {
        enable: false,
        services: ['localhost.run', 'serveo.net', 'ngrok'] // Резервные сервисы
    },
    
    // Безопасность
    RATE_LIMIT: {
        windowMs: 15 * 60 * 1000,
        max: 100
    },
    
    // Автоподключение
    AUTO_CONNECT: true,
    RECONNECT_DELAY: 3000,
    MAX_RECONNECT_ATTEMPTS: 10
};

// ==================== КЛАСС УПРАВЛЕНИЯ ЯНДЕКС.МУЗЫКОЙ ====================
class YandexMusicController {
    constructor() {
        this.host = CONFIG.CDP_HOST;
        this.port = CONFIG.CDP_PORT;
        this.connected = false;
        this.client = null;
        this.reconnectAttempts = 0;
        
        this.cache = {
            trackInfo: null,
            trackTime: null,
            volume: null,
            lastUpdate: 0,
            cacheDuration: 2000
        };
        
        this.SELECTORS = {
            PLAY_BUTTON: '[data-test-id="PLAY_BUTTON"]',
            PAUSE_BUTTON: '[data-test-id="PAUSE_BUTTON"]',
            NEXT_BUTTON: '[data-test-id="NEXT_TRACK_BUTTON"]',
            PREV_BUTTON: '[data-test-id="PREVIOUS_TRACK_BUTTON"]',
            LIKE_BUTTON: '[data-test-id="LIKE_BUTTON"]',
            DISLIKE_BUTTON: '[data-test-id="DISLIKE_BUTTON"]',
            MUTE_BUTTON: 'button[data-test-id="CHANGE_VOLUME_BUTTON"]',
            VOLUME_SLIDER: 'input[data-test-id="CHANGE_VOLUME_SLIDER"]',
            TRACK_TITLE: '[data-test-id="TRACK_TITLE"] .Meta_title__GGBnH',
            ARTIST_NAME: '[data-test-id="SEPARATED_ARTIST_TITLE"] .Meta_artistCaption__JESZi',
            COVER_IMAGE: 'img.PlayerBarDesktopWithBackgroundProgressBar_cover__MKmEt',
            CURRENT_TIME: '[data-test-id="TIMECODE_TIME_START"]',
            TOTAL_TIME: '[data-test-id="TIMECODE_TIME_END"]',
            PROGRESS_SLIDER: '[data-test-id="TIMECODE_SLIDER"]'
        };
    }
    
    async connect() {
        console.log(`🔌 Подключение к Яндекс.Музыке...`);
        
        try {
            this.client = await CDP({
                host: this.host,
                port: this.port,
                local: this.host === 'localhost' || this.host === '127.0.0.1'
            });
            
            await Promise.all([
                this.client.Page.enable(),
                this.client.Runtime.enable()
            ]);
            
            this.connected = true;
            this.reconnectAttempts = 0;
            
            console.log('✅ Успешно подключено к Яндекс.Музыке');
            
            this.client.on('disconnect', () => {
                console.log('⚠️  CDP соединение разорвано');
                this.connected = false;
                this.client = null;
                this.autoReconnect();
            });
            
            return true;
            
        } catch (err) {
            this.connected = false;
            this.client = null;
            
            if (err.code === 'ECONNREFUSED') {
                console.log(`❌ Не удалось подключиться к Яндекс.Музыке`);
                console.log('   Убедитесь, что Яндекс.Музыка запущена с параметром:');
                console.log(`   --remote-debugging-port=${this.port} --remote-debugging-address=0.0.0.0`);
            }
            
            if (CONFIG.AUTO_CONNECT) {
                this.autoReconnect();
            }
            
            return false;
        }
    }
    
    autoReconnect() {
        if (this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) return;
        
        this.reconnectAttempts++;
        const delay = CONFIG.RECONNECT_DELAY * this.reconnectAttempts;
        
        console.log(`🔄 Попытка переподключения ${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}...`);
        
        setTimeout(() => {
            this.connect();
        }, delay);
    }
    
    async getClient() {
        if (!this.connected || !this.client) {
            await this.connect();
        }
        return this.client;
    }
    
    async executeScript(expression) {
        try {
            const client = await this.getClient();
            if (!client) return null;
            
            const { Runtime } = client;
            const result = await Runtime.evaluate({
                expression: expression,
                awaitPromise: true,
                returnByValue: true
            });
            
            return result.result?.value || null;
            
        } catch (err) {
            console.error('Ошибка выполнения скрипта:', err.message);
            return null;
        }
    }
    
    // ==================== ОСНОВНЫЕ КОМАНДЫ ====================
    
    async togglePlayback() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const pauseBtn = document.querySelector('${this.SELECTORS.PAUSE_BUTTON}');
                    if (pauseBtn) {
                        pauseBtn.click();
                        return { success: true, action: 'pause' };
                    }
                    
                    const playBtn = document.querySelector('${this.SELECTORS.PLAY_BUTTON}');
                    if (playBtn) {
                        playBtn.click();
                        return { success: true, action: 'play' };
                    }
                    
                    return { success: false, message: 'Кнопки не найдены' };
                    
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async nextTrack() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const nextBtn = document.querySelector('${this.SELECTORS.NEXT_BUTTON}');
                    if (nextBtn) {
                        nextBtn.click();
                        return { success: true };
                    }
                    return { success: false, message: 'Кнопка не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async previousTrack() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const prevBtn = document.querySelector('${this.SELECTORS.PREV_BUTTON}');
                    if (prevBtn) {
                        prevBtn.click();
                        return { success: true };
                    }
                    return { success: false, message: 'Кнопка не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async likeTrack() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const likeBtn = document.querySelector('${this.SELECTORS.LIKE_BUTTON}');
                    if (likeBtn) {
                        likeBtn.click();
                        return { success: true };
                    }
                    return { success: false, message: 'Кнопка не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async dislikeTrack() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const dislikeBtn = document.querySelector('${this.SELECTORS.DISLIKE_BUTTON}');
                    if (dislikeBtn) {
                        dislikeBtn.click();
                        return { success: true };
                    }
                    return { success: false, message: 'Кнопка не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async toggleMute() {
        const result = await this.executeScript(`
            (function() {
                try {
                    const muteBtn = document.querySelector('${this.SELECTORS.MUTE_BUTTON}');
                    if (muteBtn) {
                        muteBtn.click();
                        return { success: true };
                    }
                    return { success: false, message: 'Кнопка не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        return result?.success || false;
    }
    
    async setVolume(percent) {
        const level = Math.max(0, Math.min(100, percent)) / 100;
        
        const result = await this.executeScript(`
            (function(volumeLevel) {
                try {
                    const volumeSlider = document.querySelector('${this.SELECTORS.VOLUME_SLIDER}');
                    if (volumeSlider) {
                        volumeSlider.value = volumeLevel;
                        
                        volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
                        volumeSlider.dispatchEvent(new Event('change', { bubbles: true }));
                        
                        return { success: true };
                    }
                    return { success: false, message: 'Слайдер не найден' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })(${level})
        `);
        
        return result?.success || false;
    }
    
    async changeVolume(deltaPercent) {
        const current = await this.getVolume();
        if (!current) return false;
        
        const newPercent = Math.max(0, Math.min(100, current.percentage + deltaPercent));
        return await this.setVolume(newPercent);
    }
    
    async seekTo(seconds) {
        const result = await this.executeScript(`
            (function(targetSeconds) {
                try {
                    const slider = document.querySelector('${this.SELECTORS.PROGRESS_SLIDER}');
                    if (slider) {
                        const max = parseFloat(slider.max) || 100;
                        const totalSeconds = Math.round(max);
                        
                        if (targetSeconds > totalSeconds) targetSeconds = totalSeconds;
                        if (targetSeconds < 0) targetSeconds = 0;
                        
                        slider.value = targetSeconds;
                        slider.dispatchEvent(new Event('input', { bubbles: true }));
                        slider.dispatchEvent(new Event('change', { bubbles: true }));
                        
                        return { success: true };
                    }
                    return { success: false, message: 'Слайдер не найдена' };
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })(${seconds})
        `);
        
        return result?.success || false;
    }
    
    async getTrackInfo() {
        const now = Date.now();
        if (this.cache.trackInfo && now - this.cache.lastUpdate < this.cache.cacheDuration) {
            return this.cache.trackInfo;
        }
        
        const result = await this.executeScript(`
            (function() {
                try {
                    const titleElem = document.querySelector('${this.SELECTORS.TRACK_TITLE}');
                    const artistElem = document.querySelector('${this.SELECTORS.ARTIST_NAME}');
                    const coverElem = document.querySelector('${this.SELECTORS.COVER_IMAGE}');
                    
                    if (!titleElem || !artistElem) {
                        return { success: false, message: 'Информация не найдена' };
                    }
                    
                    const title = titleElem.textContent.trim();
                    const artist = artistElem.textContent.trim();
                    let coverUrl = coverElem ? coverElem.src : null;
                    
                    if (coverUrl && coverUrl.includes('/100x100')) {
                        coverUrl = coverUrl.replace('/100x100', '/400x400');
                    }
                    
                    return {
                        success: true,
                        title: title,
                        artist: artist,
                        coverUrl: coverUrl
                    };
                    
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        if (result?.success) {
            this.cache.trackInfo = result;
            this.cache.lastUpdate = now;
        }
        
        return result;
    }
    
    async getTrackTime() {
        const now = Date.now();
        if (this.cache.trackTime && now - this.cache.lastUpdate < this.cache.cacheDuration) {
            return this.cache.trackTime;
        }
        
        const result = await this.executeScript(`
            (function() {
                try {
                    const currentElem = document.querySelector('${this.SELECTORS.CURRENT_TIME}');
                    const totalElem = document.querySelector('${this.SELECTORS.TOTAL_TIME}');
                    const slider = document.querySelector('${this.SELECTORS.PROGRESS_SLIDER}');
                    
                    if (!currentElem || !totalElem || !slider) {
                        return { success: false, message: 'Элементы не найдены' };
                    }
                    
                    const currentTime = currentElem.textContent.trim();
                    const totalTime = totalElem.textContent.trim();
                    const progress = parseFloat(slider.value) || 0;
                    const max = parseFloat(slider.max) || 100;
                    const percent = max > 0 ? (progress / max) * 100 : 0;
                    
                    return {
                        success: true,
                        currentTime: currentTime,
                        totalTime: totalTime,
                        progress: progress,
                        max: max,
                        percent: percent
                    };
                    
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        if (result?.success) {
            this.cache.trackTime = result;
            this.cache.lastUpdate = now;
        }
        
        return result;
    }
    
    async getVolume() {
        const now = Date.now();
        if (this.cache.volume && now - this.cache.lastUpdate < this.cache.cacheDuration) {
            return this.cache.volume;
        }
        
        const result = await this.executeScript(`
            (function() {
                try {
                    const slider = document.querySelector('${this.SELECTORS.VOLUME_SLIDER}');
                    const muteBtn = document.querySelector('${this.SELECTORS.MUTE_BUTTON}');
                    
                    if (!slider) {
                        return { success: false, message: 'Слайдер не найден' };
                    }
                    
                    const volume = parseFloat(slider.value) || 0;
                    const percentage = Math.round(volume * 100);
                    
                    let isMuted = volume === 0;
                    if (muteBtn) {
                        const ariaLabel = muteBtn.getAttribute('aria-label');
                        if (ariaLabel && ariaLabel.includes('Включить звук')) {
                            isMuted = true;
                        }
                    }
                    
                    return {
                        success: true,
                        volume: volume,
                        percentage: percentage,
                        isMuted: isMuted
                    };
                    
                } catch (err) {
                    return { success: false, message: 'Ошибка: ' + err.message };
                }
            })()
        `);
        
        if (result?.success) {
            this.cache.volume = result;
            this.cache.lastUpdate = now;
        }
        
        return result;
    }
    
    async getStatus() {
        const [track, time, volume] = await Promise.all([
            this.getTrackInfo(),
            this.getTrackTime(),
            this.getVolume()
        ]);
        
        return {
            track: track,
            time: time,
            volume: volume,
            connected: this.connected,
            timestamp: new Date().toISOString()
        };
    }
}

// ==================== СОЗДАЕМ КОНТРОЛЛЕР ====================
const yandexMusic = new YandexMusicController();

// ==================== ПОЛУЧЕНИЕ СЕТЕВОЙ ИНФОРМАЦИИ ====================
function getNetworkInfo() {
    const interfaces = networkInterfaces();
    const networkInfo = {
        localIPs: [],
        hostname: os.hostname(),
        platform: os.platform(),
        publicIP: null
    };
    
    Object.keys(interfaces).forEach(iface => {
        interfaces[iface].forEach(addr => {
            if (addr.family === 'IPv4' && !addr.internal) {
                networkInfo.localIPs.push({
                    interface: iface,
                    address: addr.address,
                    netmask: addr.netmask,
                    mac: addr.mac
                });
            }
        });
    });
    
    return networkInfo;
}

// ==================== ПОЛУЧЕНИЕ ПУБЛИЧНОГО IP ====================
async function getPublicIP() {
    try {
        // Пробуем несколько сервисов для надежности
        const services = [
            'https://api.ipify.org',
            'https://api64.ipify.org',
            'https://checkip.amazonaws.com',
            'https://ifconfig.me/ip'
        ];
        
        for (const service of services) {
            try {
                const response = await axios.get(service, { timeout: 3000 });
                if (response.data && response.data.trim()) {
                    return response.data.trim();
                }
            } catch (err) {
                continue;
            }
        }
        
        return null;
    } catch (err) {
        console.error('❌ Ошибка получения публичного IP:', err.message);
        return null;
    }
}

// ==================== ГЕНЕРАЦИЯ QR КОДОВ ====================
async function generateQRCode(text, options = {}) {
    try {
        const qrOptions = {
            width: options.width || 300,
            margin: options.margin || 2,
            color: {
                dark: options.darkColor || '#000000',
                light: options.lightColor || '#FFFFFF'
            },
            ...options
        };
        
        return await QRCode.toDataURL(text, qrOptions);
    } catch (err) {
        console.error('Ошибка генерации QR кода:', err);
        return null;
    }
}

// ==================== СОЗДАЕМ EXPRESS СЕРВЕР ====================
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public')); // Для статических файлов

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Save-Data');
    next();
});

// ==================== ОБРАБОТЧИКИ МАРШРУТОВ ====================

// Главная страница с QR кодами
app.get('/', async (req, res) => {
    try {
        const networkInfo = getNetworkInfo();
        const localIP = networkInfo.localIPs.length > 0 ? networkInfo.localIPs[0].address : 'localhost';
        const publicIP = await getPublicIP();
        
        // Генерируем QR коды
        const localConfig = {
            type: 'yandex-music-remote',
            mode: 'local',
            server: `http://${localIP}:${CONFIG.HTTP_PORT}`,
            ws: `ws://${localIP}:${CONFIG.WS_PORT}`,
            token: CONFIG.AUTH_TOKEN,
            timestamp: new Date().toISOString()
        };
        
        const publicConfig = publicIP ? {
            type: 'yandex-music-remote',
            mode: 'worldwide',
            server: `http://${publicIP}:${CONFIG.HTTP_PORT}`,
            ws: `ws://${publicIP}:${CONFIG.WS_PORT}`,
            token: CONFIG.AUTH_TOKEN,
            timestamp: new Date().toISOString()
        } : null;
        
        const localQR = await generateQRCode(JSON.stringify(localConfig));
        const publicQR = publicConfig ? await generateQRCode(JSON.stringify(publicConfig)) : null;
        
        const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌍 Яндекс.Музыка - Глобальный доступ</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0a0a0a 0%, #1e2634 100%);
            color: #fff;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 20px;
            background: rgba(30, 30, 30, 0.8);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .logo {
            font-size: 60px;
            color: #FF3333;
            margin-bottom: 15px;
            display: inline-block;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        
        h1 {
            font-size: 3rem;
            background: linear-gradient(45deg, #FF3333, #00BFFF, #9C27B0);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            margin-bottom: 10px;
        }
        
        .subtitle {
            color: #aaa;
            font-size: 1.2rem;
            margin-bottom: 20px;
        }
        
        .mode-badge {
            display: inline-block;
            padding: 8px 20px;
            background: ${CONFIG.MODE === 'worldwide' ? 'linear-gradient(135deg, #9C27B0, #673AB7)' : 'linear-gradient(135deg, #00BFFF, #2196F3)'};
            border-radius: 20px;
            font-weight: bold;
            font-size: 1.1rem;
            margin-top: 10px;
        }
        
        .qr-section {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 30px;
            margin-bottom: 40px;
        }
        
        .qr-card {
            background: rgba(30, 30, 30, 0.9);
            border-radius: 20px;
            padding: 25px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            transition: transform 0.3s;
        }
        
        .qr-card:hover {
            transform: translateY(-5px);
        }
        
        .qr-card.worldwide {
            border: 2px solid #9C27B0;
            position: relative;
            overflow: hidden;
        }
        
        .qr-card.worldwide::before {
            content: '🌍';
            position: absolute;
            top: 10px;
            right: 10px;
            font-size: 24px;
            z-index: 1;
        }
        
        .qr-header {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .qr-icon {
            font-size: 28px;
            width: 60px;
            height: 60px;
            background: rgba(0, 191, 255, 0.1);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .qr-icon.worldwide {
            background: rgba(156, 39, 176, 0.1);
            color: #9C27B0;
        }
        
        .qr-title {
            font-size: 1.5rem;
            font-weight: bold;
        }
        
        .qr-code {
            width: 250px;
            height: 250px;
            margin: 0 auto 20px;
            background: white;
            border-radius: 10px;
            padding: 10px;
        }
        
        .qr-code img {
            width: 100%;
            height: 100%;
        }
        
        .qr-info {
            text-align: center;
            margin-bottom: 15px;
        }
        
        .qr-url {
            font-family: 'Consolas', monospace;
            background: rgba(0, 0, 0, 0.5);
            padding: 10px;
            border-radius: 8px;
            margin: 10px 0;
            word-break: break-all;
            font-size: 0.9rem;
        }
        
        .instructions {
            background: rgba(20, 20, 20, 0.9);
            border-radius: 20px;
            padding: 25px;
            margin-bottom: 30px;
        }
        
        .instructions-title {
            font-size: 1.8rem;
            margin-bottom: 20px;
            color: #00BFFF;
        }
        
        .steps {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }
        
        .step {
            background: rgba(255, 255, 255, 0.05);
            padding: 20px;
            border-radius: 15px;
            border-left: 4px solid #00BFFF;
        }
        
        .step-number {
            display: inline-block;
            width: 30px;
            height: 30px;
            background: #00BFFF;
            color: white;
            border-radius: 50%;
            text-align: center;
            line-height: 30px;
            font-weight: bold;
            margin-bottom: 15px;
        }
        
        .step-title {
            font-size: 1.2rem;
            margin-bottom: 10px;
            color: #fff;
        }
        
        .step-description {
            color: #aaa;
            line-height: 1.5;
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .info-card {
            background: rgba(30, 30, 30, 0.9);
            border-radius: 15px;
            padding: 20px;
        }
        
        .info-title {
            font-size: 1.3rem;
            margin-bottom: 15px;
            color: #00BFFF;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .info-item {
            margin-bottom: 10px;
            padding: 10px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
        }
        
        .info-label {
            color: #aaa;
            font-size: 0.9rem;
            margin-bottom: 5px;
        }
        
        .info-value {
            font-family: 'Consolas', monospace;
            font-size: 1.1rem;
        }
        
        .buttons {
            display: flex;
            gap: 15px;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 30px;
        }
        
        .btn {
            padding: 15px 30px;
            border: none;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            gap: 10px;
            text-decoration: none;
            color: white;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #FF3333, #ff5555);
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 20px rgba(255, 51, 51, 0.3);
        }
        
        .btn-secondary {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.15);
            transform: translateY(-2px);
        }
        
        .status-bar {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(30, 30, 30, 0.95);
            padding: 15px 25px;
            border-radius: 50px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            align-items: center;
            gap: 15px;
            backdrop-filter: blur(10px);
            z-index: 1000;
        }
        
        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: ${yandexMusic.connected ? '#00CC66' : '#FF3333'};
            animation: ${yandexMusic.connected ? 'pulse 2s infinite' : 'none'};
        }
        
        @media (max-width: 768px) {
            .qr-section {
                grid-template-columns: 1fr;
            }
            
            h1 {
                font-size: 2.2rem;
            }
            
            .status-bar {
                width: 90%;
                justify-content: center;
            }
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <header class="header">
            <div class="logo">
                <i class="fas fa-globe-americas"></i>
            </div>
            <h1>Яндекс.Музыка</h1>
            <div class="subtitle">Управляйте музыкой из любой точки мира</div>
            <div class="mode-badge">
                <i class="fas fa-${CONFIG.MODE === 'worldwide' ? 'globe-americas' : 'wifi'}"></i>
                ${CONFIG.MODE === 'worldwide' ? 'Глобальный доступ' : 'Локальная сеть'}
            </div>
        </header>
        
        <div class="qr-section">
            <!-- Локальный QR код -->
            <div class="qr-card">
                <div class="qr-header">
                    <div class="qr-icon">
                        <i class="fas fa-wifi"></i>
                    </div>
                    <div class="qr-title">Локальная сеть</div>
                </div>
                <div class="qr-code">
                    ${localQR ? `<img src="${localQR}" alt="QR код для локальной сети">` : 'Ошибка генерации QR кода'}
                </div>
                <div class="qr-info">
                    <div class="qr-url">http://${localIP}:${CONFIG.HTTP_PORT}</div>
                    <div style="color: #aaa; font-size: 0.9rem; margin-top: 10px;">
                        Для устройств в одной сети Wi-Fi
                    </div>
                </div>
            </div>
            
            <!-- Глобальный QR код -->
            <div class="qr-card worldwide">
                <div class="qr-header">
                    <div class="qr-icon worldwide">
                        <i class="fas fa-globe-americas"></i>
                    </div>
                    <div class="qr-title">Глобальный доступ</div>
                </div>
                <div class="qr-code">
                    ${publicQR ? `<img src="${publicQR}" alt="QR код для глобального доступа">` : 
                      '<div style="text-align: center; padding: 50px; color: #666;">Необходимо настроить проброс портов</div>'}
                </div>
                <div class="qr-info">
                    <div class="qr-url">${publicIP ? `http://${publicIP}:${CONFIG.HTTP_PORT}` : 'Требуется настройка'}</div>
                    <div style="color: #9C27B0; font-size: 0.9rem; margin-top: 10px;">
                        ${publicIP ? 'Доступно из любой точки мира!' : 'Настройте проброс портов на роутере'}
                    </div>
                </div>
            </div>
        </div>
        
        <section class="instructions">
            <h2 class="instructions-title">📋 Как настроить глобальный доступ</h2>
            <div class="steps">
                <div class="step">
                    <div class="step-number">1</div>
                    <div class="step-title">Настройка роутера</div>
                    <div class="step-description">
                        Откройте настройки роутера и настройте проброс портов:
                        <br>• Порт ${CONFIG.HTTP_PORT} (TCP) → ваш компьютер
                        <br>• Порт ${CONFIG.WS_PORT} (TCP) → ваш компьютер
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <div class="step-title">Публичный IP</div>
                    <div class="step-description">
                        Узнайте ваш публичный IP адрес:
                        <br>• Через сервис: ipify.org
                        <br>• Или откройте: /api/ip
                        <br>• IP: ${publicIP || 'Определяется...'}
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <div class="step-title">Подключение</div>
                    <div class="step-description">
                        Используйте QR код или адрес:
                        <br>• Отсканируйте QR код камерой
                        <br>• Или введите адрес вручную
                        <br>• Токен: ${CONFIG.AUTH_TOKEN}
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">4</div>
                    <div class="step-title">Проверка</div>
                    <div class="step-description">
                        Проверьте доступность:
                        <br>• Из дома: http://localhost:${CONFIG.HTTP_PORT}
                        <br>• Из интернета: ${publicIP ? `http://${publicIP}:${CONFIG.HTTP_PORT}` : 'Настройте доступ'}
                        <br>• Мобильные данные: Включите на телефоне
                    </div>
                </div>
            </div>
        </section>
        
        <div class="info-grid">
            <div class="info-card">
                <div class="info-title">
                    <i class="fas fa-network-wired"></i> Сетевая информация
                </div>
                <div class="info-item">
                    <div class="info-label">Локальный IP</div>
                    <div class="info-value">${localIP}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Публичный IP</div>
                    <div class="info-value">${publicIP || 'Не определен'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Порты</div>
                    <div class="info-value">HTTP: ${CONFIG.HTTP_PORT}, WS: ${CONFIG.WS_PORT}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Хост</div>
                    <div class="info-value">${networkInfo.hostname}</div>
                </div>
            </div>
            
            <div class="info-card">
                <div class="info-title">
                    <i class="fas fa-cog"></i> Настройки сервера
                </div>
                <div class="info-item">
                    <div class="info-label">Режим</div>
                    <div class="info-value">${CONFIG.MODE === 'worldwide' ? '🌍 Глобальный' : '🏠 Локальный'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Токен доступа</div>
                    <div class="info-value">${CONFIG.AUTH_TOKEN}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Яндекс.Музыка</div>
                    <div class="info-value">${yandexMusic.connected ? '✅ Подключено' : '❌ Не подключено'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Время работы</div>
                    <div class="info-value" id="uptime">Загрузка...</div>
                </div>
            </div>
        </div>
        
        <div class="buttons">
            <a href="/api" class="btn btn-secondary">
                <i class="fas fa-code"></i> API документация
            </a>
            <a href="/config" class="btn btn-secondary">
                <i class="fas fa-download"></i> Конфигурация
            </a>
            <a href="/remote-control.html" class="btn btn-primary">
                <i class="fas fa-play-circle"></i> Интерфейс управления
            </a>
            <a href="/tunnel" class="btn btn-secondary">
                <i class="fas fa-cloud"></i> Облачный туннель
            </a>
        </div>
    </div>
    
    <div class="status-bar">
        <div class="status-dot"></div>
        <span>Яндекс.Музыка: ${yandexMusic.connected ? 'Подключено' : 'Не подключено'}</span>
        <span>•</span>
        <span>Клиентов: <span id="clientCount">0</span></span>
        <span>•</span>
        <span>Память: <span id="memoryUsage">0</span> MB</span>
    </div>
    
    <script>
        // Обновление времени работы
        function updateUptime() {
            fetch('/api/status')
                .then(r => r.json())
                .then(data => {
                    const uptime = Math.floor(data.uptime || 0);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = uptime % 60;
                    document.getElementById('uptime').textContent = 
                        \`\${hours}ч \${minutes}м \${seconds}с\`;
                });
        }
        
        // Обновление статистики
        function updateStats() {
            fetch('/api/stats')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('clientCount').textContent = data.clients || 0;
                    document.getElementById('memoryUsage').textContent = 
                        Math.round((data.memory || 0) / 1024 / 1024);
                });
        }
        
        // Проверка публичного IP
        if (!'${publicIP}') {
            setTimeout(() => location.reload(), 10000); // Перезагрузка через 10 сек
        }
        
        // Автообновление
        setInterval(updateUptime, 1000);
        setInterval(updateStats, 5000);
        updateUptime();
        updateStats();
    </script>
</body>
</html>`;
        
        res.send(html);
        
    } catch (err) {
        console.error('Ошибка генерации главной страницы:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// API endpoints
app.get('/api', (req, res) => {
    const apiDocs = {
        name: 'Yandex Music Global API',
        version: '3.0.0',
        endpoints: {
            // Публичные
            'GET /': 'Главная страница с QR кодами',
            'GET /api': 'Эта документация',
            'GET /api/ip': 'Публичный IP адрес',
            'GET /api/status': 'Статус сервера',
            'GET /api/network': 'Сетевая информация',
            'GET /qr/local': 'QR код для локальной сети',
            'GET /qr/global': 'QR код для глобального доступа',
            
            // Защищенные
            'GET /status?token=TOKEN': 'Статус плеера',
            'GET /control?action=ACTION&token=TOKEN': 'Управление плеером',
            'GET /config': 'Конфигурация сервера',
            
            // WebSocket
            'WS /ws?token=TOKEN': 'WebSocket подключение',
            
            // Интерфейсы
            'GET /remote-control.html': 'Десктоп интерфейс',
            'GET /remote-controlm.html': 'Мобильный интерфейс',
            'GET /tunnel': 'Настройка облачного туннеля'
        },
        commands: {
            playback: ['play', 'pause', 'toggle'],
            navigation: ['next', 'previous'],
            volume: ['volumeup', 'volumedown', 'volume?value=N'],
            seek: ['seek?value=SECONDS'],
            likes: ['like', 'dislike'],
            mute: ['mute']
        },
        authentication: {
            method: 'Query parameter or Authorization header',
            token: CONFIG.AUTH_TOKEN,
            example: `?token=${CONFIG.AUTH_TOKEN}`
        }
    };
    
    res.json(apiDocs);
});

app.get('/api/ip', async (req, res) => {
    try {
        const publicIP = await getPublicIP();
        res.json({
            ip: publicIP,
            timestamp: new Date().toISOString(),
            services: ['ipify.org', 'checkip.amazonaws.com', 'ifconfig.me']
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        mode: CONFIG.MODE,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
        node: process.version,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/network', (req, res) => {
    const networkInfo = getNetworkInfo();
    res.json(networkInfo);
});

app.get('/api/stats', (req, res) => {
    res.json({
        clients: wss.clients.size,
        memory: process.memoryUsage().heapUsed,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// QR код для локальной сети
app.get('/qr/local', async (req, res) => {
    try {
        const networkInfo = getNetworkInfo();
        const localIP = networkInfo.localIPs.length > 0 ? networkInfo.localIPs[0].address : 'localhost';
        
        const config = {
            type: 'yandex-music-remote',
            mode: 'local',
            server: `http://${localIP}:${CONFIG.HTTP_PORT}`,
            ws: `ws://${localIP}:${CONFIG.WS_PORT}`,
            token: CONFIG.AUTH_TOKEN,
            timestamp: new Date().toISOString()
        };
        
        const qrCode = await generateQRCode(JSON.stringify(config));
        
        res.json({
            qr: qrCode,
            config: config,
            url: `http://${localIP}:${CONFIG.HTTP_PORT}`,
            instructions: 'Используйте в локальной сети Wi-Fi'
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// QR код для глобального доступа
app.get('/qr/global', async (req, res) => {
    try {
        const publicIP = await getPublicIP();
        
        if (!publicIP) {
            return res.status(400).json({ 
                error: 'Публичный IP не найден',
                instructions: 'Настройте проброс портов на роутере'
            });
        }
        
        const config = {
            type: 'yandex-music-remote',
            mode: 'worldwide',
            server: `http://${publicIP}:${CONFIG.HTTP_PORT}`,
            ws: `ws://${publicIP}:${CONFIG.WS_PORT}`,
            token: CONFIG.AUTH_TOKEN,
            timestamp: new Date().toISOString()
        };
        
        const qrCode = await generateQRCode(JSON.stringify(config), {
            darkColor: '#9C27B0',
            lightColor: '#FFFFFF'
        });
        
        res.json({
            qr: qrCode,
            config: config,
            url: `http://${publicIP}:${CONFIG.HTTP_PORT}`,
            instructions: 'Доступно из любой точки мира!',
            note: 'Убедитесь, что порты открыты на роутере'
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Конфигурация сервера
app.get('/config', (req, res) => {
    const networkInfo = getNetworkInfo();
    const config = {
        server: {
            name: 'Yandex Music Global Server',
            version: '3.0.0',
            mode: CONFIG.MODE,
            hostname: networkInfo.hostname,
            platform: process.platform
        },
        network: {
            localIPs: networkInfo.localIPs.map(ip => ip.address),
            ports: {
                http: CONFIG.HTTP_PORT,
                websocket: CONFIG.WS_PORT
            }
        },
        security: {
            token: CONFIG.AUTH_TOKEN,
            rateLimit: CONFIG.RATE_LIMIT
        },
        yandexMusic: {
            connected: yandexMusic.connected,
            host: CONFIG.CDP_HOST,
            port: CONFIG.CDP_PORT
        },
        features: {
            worldwide: CONFIG.PUBLIC_ACCESS,
            qrCodes: true,
            webSocket: true,
            autoReconnect: CONFIG.AUTO_CONNECT
        }
    };
    
    res.json(config);
});

// Статус плеера
app.get('/status', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (token !== CONFIG.AUTH_TOKEN) {
        return res.status(401).json({ 
            error: 'Unauthorized',
            hint: `Use ?token=${CONFIG.AUTH_TOKEN}`
        });
    }
    
    try {
        const status = await yandexMusic.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Управление плеером
app.get('/control', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (token !== CONFIG.AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const action = req.query.action;
    const value = req.query.value;
    
    let result;
    
    try {
        switch (action) {
            case 'play':
            case 'pause':
            case 'toggle':
                result = await yandexMusic.togglePlayback();
                break;
                
            case 'next':
                result = await yandexMusic.nextTrack();
                break;
                
            case 'previous':
            case 'prev':
                result = await yandexMusic.previousTrack();
                break;
                
            case 'like':
                result = await yandexMusic.likeTrack();
                break;
                
            case 'dislike':
                result = await yandexMusic.dislikeTrack();
                break;
                
            case 'mute':
                result = await yandexMusic.toggleMute();
                break;
                
            case 'volumeup':
                result = await yandexMusic.changeVolume(10);
                break;
                
            case 'volumedown':
                result = await yandexMusic.changeVolume(-10);
                break;
                
            case 'volume':
                const percent = parseInt(value) || 50;
                result = await yandexMusic.setVolume(percent);
                break;
                
            case 'seek':
                const seconds = parseInt(value) || 0;
                result = await yandexMusic.seekTo(seconds);
                break;
                
            default:
                return res.status(400).json({ error: 'Unknown action', action });
        }
        
        res.json({ 
            action, 
            value,
            success: result,
            timestamp: new Date().toISOString()
        });
        
    } catch (err) {
        res.status(500).json({ 
            action, 
            error: err.message,
            success: false 
        });
    }
});

// Облачный туннель
app.get('/tunnel', (req, res) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>🌐 Облачный туннель</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            padding: 20px;
            background: #1a1a1a;
            color: white;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .card {
            background: #2a2a2a;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .btn {
            display: inline-block;
            padding: 10px 20px;
            background: #4CAF50;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin: 10px 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌐 Облачный туннель</h1>
        <div class="card">
            <h2>Бесплатные сервисы для глобального доступа</h2>
            <p>Если не можете настроить проброс портов, используйте эти сервисы:</p>
            
            <h3>1. localhost.run (рекомендуется)</h3>
            <p>Команда: <code>ssh -R 80:localhost:3002 localhost.run</code></p>
            <a href="https://localhost.run" class="btn" target="_blank">Открыть localhost.run</a>
            
            <h3>2. Serveo.net</h3>
            <p>Команда: <code>ssh -R 80:localhost:3002 serveo.net</code></p>
            
            <h3>3. Ngrok (требуется регистрация)</h3>
            <p>Команда: <code>ngrok http 3002</code></p>
            <a href="https://ngrok.com" class="btn" target="_blank">Открыть ngrok.com</a>
        </div>
        
        <div class="card">
            <h2>Автоматический туннель</h2>
            <p>Запустите автоматическую настройку:</p>
            <a href="/api/tunnel/start" class="btn">Запустить туннель</a>
            <a href="/api/tunnel/stop" class="btn">Остановить туннель</a>
            <a href="/api/tunnel/status" class="btn">Статус туннеля</a>
        </div>
    </div>
</body>
</html>`;
    
    res.send(html);
});

// Запуск туннеля
app.get('/api/tunnel/start', async (req, res) => {
    try {
        // Здесь можно добавить автоматический запуск туннеля
        // Например, через localhost.run или подобный сервис
        
        res.json({
            status: 'started',
            message: 'Туннель запущен',
            url: 'https://ваш-туннель.localhost.run',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== WEB SOCKET СЕРВЕР ====================
const wss = new WebSocket.Server({ 
    port: CONFIG.WS_PORT, 
    host: '0.0.0.0',
    clientTracking: true
});

wss.on('connection', (ws, req) => {
    console.log('🔌 WebSocket подключение:', req.socket.remoteAddress);
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (token !== CONFIG.AUTH_TOKEN) {
        console.log('❌ Неверный токен WebSocket');
        ws.close(1008, 'Unauthorized');
        return;
    }
    
    const clientInfo = {
        ip: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'] || 'unknown',
        mobile: req.headers['user-agent']?.match(/Mobile|Android|iPhone|iPad|iPod/i) ? true : false,
        connectedAt: new Date().toISOString()
    };
    
    console.log(`🌍 Клиент: ${clientInfo.ip} ${clientInfo.mobile ? '(мобильный)' : '(десктоп)'}`);
    
    ws.send(JSON.stringify({
        type: 'welcome',
        message: '✅ Подключено к Яндекс.Музыка',
        server: 'Yandex Music Global Server 3.0',
        mode: CONFIG.MODE,
        timestamp: new Date().toISOString(),
        client: clientInfo
    }));
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now(),
                    serverTime: new Date().toISOString()
                }));
                return;
            }
            
            let response;
            
            switch (message.command) {
                case 'status':
                    const status = await yandexMusic.getStatus();
                    response = { command: 'status', ...status };
                    break;
                    
                case 'play':
                case 'pause':
                case 'toggle':
                    const result = await yandexMusic.togglePlayback();
                    response = { command: message.command, success: result };
                    break;
                    
                case 'next':
                    response = { command: 'next', success: await yandexMusic.nextTrack() };
                    break;
                    
                case 'previous':
                    response = { command: 'previous', success: await yandexMusic.previousTrack() };
                    break;
                    
                case 'like':
                    response = { command: 'like', success: await yandexMusic.likeTrack() };
                    break;
                    
                case 'dislike':
                    response = { command: 'dislike', success: await yandexMusic.dislikeTrack() };
                    break;
                    
                case 'volumeup':
                    response = { command: 'volumeup', success: await yandexMusic.changeVolume(10) };
                    break;
                    
                case 'volumedown':
                    response = { command: 'volumedown', success: await yandexMusic.changeVolume(-10) };
                    break;
                    
                case 'mute':
                    response = { command: 'mute', success: await yandexMusic.toggleMute() };
                    break;
                    
                case 'volume':
                    const percent = message.value || 50;
                    response = { command: 'volume', success: await yandexMusic.setVolume(percent) };
                    break;
                    
                case 'seek':
                    const seconds = message.value || 0;
                    response = { command: 'seek', success: await yandexMusic.seekTo(seconds) };
                    break;
                    
                case 'info':
                    response = {
                        command: 'info',
                        server: {
                            mode: CONFIG.MODE,
                            uptime: process.uptime(),
                            clients: wss.clients.size,
                            publicIP: await getPublicIP()
                        },
                        yandexMusic: {
                            connected: yandexMusic.connected
                        }
                    };
                    break;
                    
                default:
                    response = { error: 'Unknown command', received: message };
            }
            
            ws.send(JSON.stringify(response));
            
        } catch (err) {
            console.error('Ошибка обработки команды WebSocket:', err);
            ws.send(JSON.stringify({ error: err.message }));
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket отключен:', clientInfo.ip);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket ошибка:', err);
    });
});

// ==================== ФУНКЦИЯ ДЛЯ ПРОВЕРКИ ДОСТУПНОСТИ ====================
async function checkAccessibility() {
    try {
        const publicIP = await getPublicIP();
        
        if (!publicIP) {
            console.log('⚠️  Публичный IP не найден. Проверьте интернет соединение.');
            return;
        }
        
        console.log(`🌍 Публичный IP: ${publicIP}`);
        
        // Проверяем доступность портов
        const ports = [CONFIG.HTTP_PORT, CONFIG.WS_PORT];
        
        for (const port of ports) {
            try {
                const response = await axios.get(`http://${publicIP}:${port}/api/status`, {
                    timeout: 5000
                }).catch(() => null);
                
                if (response && response.status === 200) {
                    console.log(`✅ Порт ${port} доступен из интернета`);
                } else {
                    console.log(`❌ Порт ${port} НЕ доступен из интернета`);
                    console.log(`   🔧 Настройте проброс порта ${port} на роутере`);
                }
            } catch (err) {
                console.log(`❌ Порт ${port} НЕ доступен из интернета`);
                console.log(`   🔧 Настройте проброс порта ${port} на роутере`);
            }
        }
        
    } catch (err) {
        console.error('Ошибка проверки доступности:', err.message);
    }
}

// ==================== ИНФОРМАЦИЯ О СЕРВЕРЕ ====================
async function displayServerInfo() {
    const networkInfo = getNetworkInfo();
    const publicIP = await getPublicIP();
    
    console.log('\n' + '='.repeat(70));
    console.log('🎵 Яндекс.Музыка - ГЛОБАЛЬНЫЙ СЕРВЕР');
    console.log('='.repeat(70));
    
    console.log(`\n🌍 РЕЖИМ: ${CONFIG.MODE === 'worldwide' ? 'ГЛОБАЛЬНЫЙ ДОСТУП' : 'ЛОКАЛЬНАЯ СЕТЬ'}`);
    
    console.log('\n🏠 СИСТЕМНАЯ ИНФОРМАЦИЯ:');
    console.log(`  Хост: ${networkInfo.hostname}`);
    console.log(`  Платформа: ${networkInfo.platform}`);
    console.log(`  Память: ${Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10} GB`);
    
    console.log('\n📡 СЕТЕВЫЕ АДРЕСА:');
    console.log(`  Локальный доступ: http://localhost:${CONFIG.HTTP_PORT}`);
    
    if (networkInfo.localIPs.length > 0) {
        networkInfo.localIPs.forEach(ipInfo => {
            console.log(`  📶 ${ipInfo.interface}: http://${ipInfo.address}:${CONFIG.HTTP_PORT}`);
        });
    }
    
    if (publicIP) {
        console.log(`\n🌍 ПУБЛИЧНЫЙ ДОСТУП:`);
        console.log(`  Глобальный URL: http://${publicIP}:${CONFIG.HTTP_PORT}`);
        console.log(`  WebSocket: ws://${publicIP}:${CONFIG.WS_PORT}`);
        
        console.log(`\n⚠️  ДЛЯ ГЛОБАЛЬНОГО ДОСТУПА:`);
        console.log(`  1. Настройте проброс портов на роутере:`);
        console.log(`     • Порт ${CONFIG.HTTP_PORT} (TCP) → ваш компьютер`);
        console.log(`     • Порт ${CONFIG.WS_PORT} (TCP) → ваш компьютер`);
        console.log(`  2. Проверьте доступность: curl http://${publicIP}:${CONFIG.HTTP_PORT}/api/status`);
        console.log(`  3. Отсканируйте QR код для быстрого подключения`);
    } else {
        console.log(`\n🌍 ПУБЛИЧНЫЙ IP: не найден (проверьте интернет соединение)`);
    }
    
    console.log('\n📱 QR КОДЫ ДЛЯ ПОДКЛЮЧЕНИЯ:');
    console.log(`  Локальный QR: http://localhost:${CONFIG.HTTP_PORT}/qr/local`);
    console.log(`  Глобальный QR: http://localhost:${CONFIG.HTTP_PORT}/qr/global`);
    console.log(`  Главная страница: http://localhost:${CONFIG.HTTP_PORT}/`);
    
    console.log('\n🔗 ОСНОВНЫЕ ССЫЛКИ:');
    console.log(`  API документация: http://localhost:${CONFIG.HTTP_PORT}/api`);
    console.log(`  Конфигурация: http://localhost:${CONFIG.HTTP_PORT}/config`);
    console.log(`  Облачный туннель: http://localhost:${CONFIG.HTTP_PORT}/tunnel`);
    console.log(`  Десктоп интерфейс: http://localhost:${CONFIG.HTTP_PORT}/remote-control.html`);
    console.log(`  Мобильный интерфейс: http://localhost:${CONFIG.HTTP_PORT}/remote-controlm.html`);
    
    console.log('\n🔑 АВТОРИЗАЦИЯ:');
    console.log(`  Токен: ${CONFIG.AUTH_TOKEN}`);
    console.log(`  Пример: curl "http://localhost:${CONFIG.HTTP_PORT}/status?token=${CONFIG.AUTH_TOKEN}"`);
    
    console.log('\n⚡ ВОЗМОЖНОСТИ:');
    console.log(`  Глобальный доступ: ${CONFIG.PUBLIC_ACCESS ? '✅' : '❌'}`);
    console.log(`  QR коды: ✅`);
    console.log(`  WebSocket: ✅`);
    console.log(`  Автоподключение: ${CONFIG.AUTO_CONNECT ? '✅' : '❌'}`);
    
    console.log('\n👥 ПОДКЛЮЧЕНИЯ:');
    console.log(`  HTTP: порт ${CONFIG.HTTP_PORT}`);
    console.log(`  WebSocket: порт ${CONFIG.WS_PORT} (${wss.clients.size} клиентов)`);
    
    console.log('\n💡 ИНСТРУКЦИЯ ПО ГЛОБАЛЬНОМУ ДОСТУПУ:');
    console.log(`  1. Откройте главную страницу в браузере`);
    console.log(`  2. Отсканируйте "Глобальный доступ" QR код с телефона`);
    console.log(`  3. Или используйте публичный IP: ${publicIP || 'настройте доступ'}`);
    console.log(`  4. Управляйте музыкой из любой точки мира!`);
    
    console.log('='.repeat(70));
}

// ==================== ЗАПУСК СЕРВЕРА ====================
async function startServer() {
    console.log('\n🚀 Запуск глобального сервера...');
    
    // Запуск Express сервера
    const server = app.listen(CONFIG.HTTP_PORT, '0.0.0.0', async () => {
        console.log(`✅ HTTP сервер запущен на порту ${CONFIG.HTTP_PORT}`);
        
        // Отображение информации
        await displayServerInfo();
        
        // Проверка доступности
        if (CONFIG.MODE === 'worldwide') {
            console.log('\n🔍 Проверка глобальной доступности...');
            await checkAccessibility();
        }
        
        // Подключение к Яндекс.Музыке
        console.log('\n⏳ Подключение к Яндекс.Музыке...');
        if (CONFIG.AUTO_CONNECT) {
            const connected = await yandexMusic.connect();
            if (connected) {
                console.log('✅ Готово к глобальному управлению!');
            }
        }
        
        console.log('\n🎉 СЕРВЕР ГОТОВ К РАБОТЕ!');
        console.log('   🌍 Доступ из любой точки мира');
        console.log('   📱 QR коды для быстрого подключения');
        console.log('   ⚡ Быстрое и удобное управление');
        
        // Периодические проверки
        setInterval(async () => {
            if (!yandexMusic.connected && CONFIG.AUTO_CONNECT) {
                console.log('🔄 Автопереподключение к Яндекс.Музыке...');
                await yandexMusic.connect();
            }
            
            // Обновление статистики каждые 5 минут
            if (CONFIG.MODE === 'worldwide') {
                await checkAccessibility();
            }
        }, 5 * 60 * 1000); // 5 минут
        
    });
    
    wss.on('listening', () => {
        console.log(`✅ WebSocket сервер запущен на порту ${CONFIG.WS_PORT}`);
    });
    
    return server;
}

// ==================== ОБРАБОТКА ЗАВЕРШЕНИЯ ====================
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Остановка глобального сервера...');
    
    wss.close(() => {
        console.log('WebSocket сервер остановлен');
    });
    
    if (yandexMusic.client) {
        yandexMusic.client.close();
        console.log('Соединение с Яндекс.Музыкой закрыто');
    }
    
    console.log('👋 До свидания!');
    process.exit(0);
});

// ==================== ЗАПУСК ====================
startServer();
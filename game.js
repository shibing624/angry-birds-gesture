/**
 * Angry Birds - Gesture Control Edition
 * 愤怒的小鸟手势版
 * 
 * 通过摄像头手势识别控制小鸟发射，消灭所有小猪过关
 * 技术栈: MediaPipe Hands + Canvas 2D + Web Audio API
 */

// ============== 物理常量 ==============
// 重力加速度，影响小鸟和物体下落速度
const GRAVITY = 0.5;
// 摩擦系数，每帧速度衰减比例(0.99表示保留99%速度)
const FRICTION = 0.99;

// ============== 布局常量 ==============
// 地面Y坐标占画布高度的比例
const GROUND_Y_RATIO = 0.85;
// 弹弓X坐标占画布宽度的比例(0.75表示在右侧3/4处)
const SLINGSHOT_X_RATIO = 0.75; 
// 弹弓Y坐标占画布高度的比例
const SLINGSHOT_Y_RATIO = 0.65;

// ============== 发射参数 ==============
// 最大拉动距离(像素)，超过此距离不再增加力量
const MAX_PULL_DISTANCE = 150;
// 发射力量乘数，将拉动距离转换为初始速度
const LAUNCH_POWER_MULTIPLIER = 0.38;
// 最大发射速度，防止速度过快导致穿透
const MAX_LAUNCH_SPEED = 55;

// 图片资源
const images = {
    cloud: null,
    pig: null,
    bird: null,
    loaded: false
};

// 加载图片资源
function loadImages() {
    return new Promise((resolve) => {
        let loadedCount = 0;
        const totalImages = 3;
        
        const onLoad = () => {
            loadedCount++;
            if (loadedCount >= totalImages) {
                images.loaded = true;
                resolve();
            }
        };
        
        images.cloud = new Image();
        images.cloud.onload = onLoad;
        images.cloud.onerror = onLoad;
        images.cloud.src = 'assets/cloud.png';
        
        images.pig = new Image();
        images.pig.onload = onLoad;
        images.pig.onerror = onLoad;
        images.pig.src = 'assets/pig.png';
        
        images.bird = new Image();
        images.bird.onload = onLoad;
        images.bird.onerror = onLoad;
        images.bird.src = 'assets/red_bird_left.png';
    });
}

// 音效管理器
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

class AudioController {
    static playTone(freq, type, duration, vol = 0.1) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    }

    static playPull() { this.playTone(150, 'triangle', 0.1, 0.05); }

    static playLaunch() {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.setValueAtTime(200, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    }
}

// 游戏状态
const gameState = {
    isLoaded: false,
    isCameraActive: false,
    cameraStream: null,
    hands: null,
    isPlaying: false,
    isPulling: false,
    canLaunch: true,
    needsHandReset: false,
    score: 0,
    level: 1,
    birdsLeft: 5,
    currentBird: null,
    pullStart: null,
    pullEnd: null,
    launchVelocity: { x: 0, y: 0 },
    pigs: [],
    blocks: [],
    particles: [],
    clouds: [],
    trajectory: [],
    handLandmarks: null,
    pinchDistance: 0,
    isPinching: false,
    handCenter: { x: 0, y: 0 },
    pullStartTime: null,
    minPullDuration: 2000,
    levelPassed: false,
    // 移动端触控状态
    isTouchDevice: false,
    touchStartPos: null,
    isTouching: false
};

// DOM 元素
const elements = {
    canvas: document.getElementById('game-canvas'),
    camera: document.getElementById('camera'),
    handOverlay: document.getElementById('hand-overlay'),
    loadingScreen: document.getElementById('loading-screen'),
    loadProgress: document.getElementById('load-progress'),
    restartBtn: document.getElementById('restart-btn'),
    nextBtn: document.getElementById('next-btn'),
    retryBtn: document.getElementById('retry-btn'),
    modalNextBtn: document.getElementById('modal-next-btn'),
    scoreDisplay: document.getElementById('score'),
    levelDisplay: document.getElementById('level'),
    birdsLeftDisplay: document.getElementById('birds-left'),
    birdsCountLarge: document.getElementById('birds-count-large'),
    gestureText: document.getElementById('gesture-text'),
    handIcon: document.getElementById('hand-icon'),
    powerFill: document.getElementById('power-fill'),
    powerValue: document.getElementById('power-value'),
    gameModal: document.getElementById('game-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalScore: document.getElementById('modal-score'),
    modalStars: document.getElementById('modal-stars'),
    modalHint: document.getElementById('modal-hint')
};

// 画布上下文
let ctx;
let handCtx;

/**
 * 关卡定义 - 物体按放置顺序定义
 * 规则：
 * 1. 物体按定义顺序依次放置
 * 2. 新物体会检查与已放置物体的x范围是否重叠
 * 3. 如果x范围重叠，新物体会堆叠在已有物体上方
 * 4. 猪和其头顶木块必须紧挨着定义（先猪后木块）
 */
const LEVEL_DEFINITIONS = [
    // 第1关：简单入门
    {
        birds: 5,
        objects: [
            // 左柱子
            { x: 0.15, type: 'pillar', material: 'wood', height: 80 },
            // 右柱子
            { x: 0.35, type: 'pillar', material: 'wood', height: 80 },
            // 横梁（放在柱子上）
            { x: 0.25, type: 'beam', material: 'wood', width: 160 },
            // 猪（放在横梁上）
            { x: 0.25, type: 'pig', radius: 22 },
            // 猪头顶木块
            { x: 0.25, type: 'block', material: 'wood', width: 50, height: 20 }
        ]
    },
    // 第2关：双塔结构
    {
        birds: 6,
        objects: [
            // 左塔
            { x: 0.12, type: 'pillar', material: 'wood', height: 90 },
            { x: 0.20, type: 'pillar', material: 'wood', height: 90 },
            { x: 0.16, type: 'beam', material: 'wood', width: 70 },
            { x: 0.16, type: 'pig', radius: 18 },
            { x: 0.16, type: 'block', material: 'wood', width: 40, height: 15 },
            // 右塔
            { x: 0.36, type: 'pillar', material: 'wood', height: 90 },
            { x: 0.44, type: 'pillar', material: 'wood', height: 90 },
            { x: 0.40, type: 'beam', material: 'wood', width: 70 },
            { x: 0.40, type: 'pig', radius: 18 },
            { x: 0.40, type: 'block', material: 'wood', width: 40, height: 15 },
            // 顶部横梁连接两塔
            { x: 0.28, type: 'beam', material: 'wood', width: 180 }
        ]
    },
    // 第3关：石木混合堡垒
    {
        birds: 7,
        objects: [
            // 外墙石柱
            { x: 0.08, type: 'pillar', material: 'stone', height: 100 },
            { x: 0.52, type: 'pillar', material: 'stone', height: 100 },
            // 内部三个木柱
            { x: 0.18, type: 'pillar', material: 'wood', height: 80 },
            { x: 0.30, type: 'pillar', material: 'wood', height: 80 },
            { x: 0.42, type: 'pillar', material: 'wood', height: 80 },
            // 第一层石梁
            { x: 0.30, type: 'beam', material: 'stone', width: 220 },
            // 第一层猪（左）
            { x: 0.18, type: 'pig', radius: 16 },
            { x: 0.18, type: 'block', material: 'wood', width: 35, height: 12 },
            // 第一层猪（中）
            { x: 0.30, type: 'pig', radius: 18 },
            { x: 0.30, type: 'block', material: 'stone', width: 40, height: 12 },
            // 第一层猪（右）
            { x: 0.42, type: 'pig', radius: 16 },
            { x: 0.42, type: 'block', material: 'wood', width: 35, height: 12 },
            // 第二层柱子
            { x: 0.24, type: 'pillar', material: 'wood', height: 50 },
            { x: 0.36, type: 'pillar', material: 'wood', height: 50 },
            // 顶部横梁
            { x: 0.30, type: 'beam', material: 'stone', width: 120 }
        ]
    },
    // 第4关：多层城堡
    {
        birds: 8,
        objects: [
            // 外墙石柱
            { x: 0.06, type: 'pillar', material: 'stone', height: 120 },
            { x: 0.54, type: 'pillar', material: 'stone', height: 120 },
            // 内部木柱
            { x: 0.18, type: 'pillar', material: 'wood', height: 100 },
            { x: 0.30, type: 'pillar', material: 'wood', height: 100 },
            { x: 0.42, type: 'pillar', material: 'wood', height: 100 },
            // 第一层石梁
            { x: 0.30, type: 'beam', material: 'stone', width: 240 },
            // 底层猪（左）
            { x: 0.18, type: 'pig', radius: 16 },
            { x: 0.18, type: 'block', material: 'wood', width: 35, height: 12 },
            // 底层猪（中）
            { x: 0.30, type: 'pig', radius: 18 },
            { x: 0.30, type: 'block', material: 'wood', width: 40, height: 12 },
            // 底层猪（右）
            { x: 0.42, type: 'pig', radius: 16 },
            { x: 0.42, type: 'block', material: 'wood', width: 35, height: 12 },
            // 第二层柱子
            { x: 0.24, type: 'pillar', material: 'wood', height: 60 },
            { x: 0.36, type: 'pillar', material: 'wood', height: 60 },
            // 第二层横梁
            { x: 0.30, type: 'beam', material: 'stone', width: 140 },
            // 顶层猪
            { x: 0.30, type: 'pig', radius: 20 },
            { x: 0.30, type: 'block', material: 'wood', width: 45, height: 15 }
        ]
    },
    // 第5关：终极堡垒
    {
        birds: 10,
        objects: [
            // 外墙石柱
            { x: 0.04, type: 'pillar', material: 'stone', height: 140 },
            { x: 0.60, type: 'pillar', material: 'stone', height: 140 },
            // 内部五根木柱
            { x: 0.14, type: 'pillar', material: 'wood', height: 110 },
            { x: 0.24, type: 'pillar', material: 'wood', height: 110 },
            { x: 0.32, type: 'pillar', material: 'wood', height: 110 },
            { x: 0.40, type: 'pillar', material: 'wood', height: 110 },
            { x: 0.50, type: 'pillar', material: 'wood', height: 110 },
            // 第一层石梁
            { x: 0.32, type: 'beam', material: 'stone', width: 300 },
            // 底层猪（4只，分布在柱子之间）
            { x: 0.14, type: 'pig', radius: 14 },
            { x: 0.14, type: 'block', material: 'wood', width: 32, height: 10 },
            { x: 0.28, type: 'pig', radius: 16 },
            { x: 0.28, type: 'block', material: 'wood', width: 35, height: 10 },
            { x: 0.36, type: 'pig', radius: 16 },
            { x: 0.36, type: 'block', material: 'wood', width: 35, height: 10 },
            { x: 0.50, type: 'pig', radius: 14 },
            { x: 0.50, type: 'block', material: 'wood', width: 32, height: 10 },
            // 第二层柱子
            { x: 0.24, type: 'pillar', material: 'wood', height: 60 },
            { x: 0.40, type: 'pillar', material: 'wood', height: 60 },
            // 第二层横梁
            { x: 0.32, type: 'beam', material: 'stone', width: 180 },
            // 中层猪
            { x: 0.32, type: 'pig', radius: 18 },
            { x: 0.32, type: 'block', material: 'wood', width: 40, height: 12 },
            // 第三层柱子
            { x: 0.28, type: 'pillar', material: 'wood', height: 40 },
            { x: 0.36, type: 'pillar', material: 'wood', height: 40 },
            // 顶部横梁
            { x: 0.32, type: 'beam', material: 'wood', width: 100 },
            // 顶层猪
            { x: 0.32, type: 'pig', radius: 16 },
            { x: 0.32, type: 'block', material: 'stone', width: 35, height: 12 }
        ]
    }
];

/**
 * 物理世界堆叠系统
 * 确保物体不重叠，只能向上堆叠
 */
class PhysicsWorld {
    constructor(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.groundY = canvasHeight * GROUND_Y_RATIO;
        this.occupiedSpaces = [];
    }
    
    /**
     * 获取物体尺寸
     */
    getObjectSize(obj) {
        if (obj.type === 'pig') {
            const radius = obj.radius || 20;
            return { width: radius * 2, height: radius * 2, radius };
        } else if (obj.type === 'pillar') {
            return { width: 15, height: obj.height || 80 };
        } else if (obj.type === 'beam') {
            return { width: obj.width || 100, height: 15 };
        } else {
            return { width: obj.width || 40, height: obj.height || 40 };
        }
    }
    
    /**
     * 查找物体应该放置的y坐标（底部）
     * 检查所有x范围重叠的已放置物体，取最高点
     */
    findPlacementY(xLeft, xRight) {
        let highestTop = this.groundY;
        
        for (const space of this.occupiedSpaces) {
            // 检查x范围是否重叠（有交集）
            if (xRight > space.xLeft && xLeft < space.xRight) {
                // x有重叠，新物体必须放在这个物体上方
                if (space.top < highestTop) {
                    highestTop = space.top;
                }
            }
        }
        
        return highestTop;
    }
    
    /**
     * 放置物体
     */
    placeObject(obj) {
        const x = obj.x * this.canvasWidth;
        const size = this.getObjectSize(obj);
        
        const xLeft = x - size.width / 2;
        const xRight = x + size.width / 2;
        
        // 找到放置位置
        const bottomY = this.findPlacementY(xLeft, xRight);
        const centerY = bottomY - size.height / 2;
        const topY = bottomY - size.height;
        
        // 记录占用空间
        this.occupiedSpaces.push({
            xLeft, xRight,
            top: topY,
            bottom: bottomY,
            type: obj.type
        });
        
        if (obj.type === 'pig') {
            return { type: 'pig', x, y: centerY, radius: size.radius };
        } else {
            return {
                type: 'block', x, y: centerY,
                width: size.width, height: size.height,
                material: obj.material || 'wood'
            };
        }
    }
    
    /**
     * 处理关卡所有物体
     */
    processLevel(objects) {
        const pigs = [];
        const blocks = [];
        
        for (const obj of objects) {
            const placed = this.placeObject(obj);
            
            if (placed.type === 'pig') {
                pigs.push({
                    x: placed.x, y: placed.y, radius: placed.radius,
                    health: placed.radius, vx: 0, vy: 0
                });
            } else {
                blocks.push({
                    x: placed.x, y: placed.y,
                    width: placed.width, height: placed.height,
                    type: placed.material,
                    health: placed.material === 'stone' ? 100 : 50,
                    vx: 0, vy: 0
                });
            }
        }
        
        return { pigs, blocks };
    }
}

// 初始化加载进度
let loadProgress = 0;
/**
 * 更新加载进度条
 * @param {number} increment - 进度增量(0-100)
 */
function updateLoadProgress(increment) {
    loadProgress = Math.min(loadProgress + increment, 100);
    elements.loadProgress.style.width = loadProgress + '%';
    if (loadProgress >= 100) {
        setTimeout(() => {
            elements.loadingScreen.classList.add('hidden');
            gameState.isLoaded = true;
        }, 500);
    }
}

/**
 * 检测是否为触控设备
 * @returns {boolean} 是否支持触控
 */
function isTouchDevice() {
    return ('ontouchstart' in window) || 
           (navigator.maxTouchPoints > 0) || 
           (navigator.msMaxTouchPoints > 0);
}

/**
 * 初始化触控事件监听
 * 为移动端提供触控拖拽发射小鸟的能力
 */
function initTouchControls() {
    const canvas = elements.canvas;
    
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    
    // 鼠标事件兼容(PC端备用)
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
}

/**
 * 处理触控开始事件
 * @param {TouchEvent} e - 触控事件对象
 */
function handleTouchStart(e) {
    e.preventDefault();
    if (!gameState.canLaunch || !gameState.currentBird) return;
    
    const touch = e.touches[0];
    const rect = elements.canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    // 检查是否点击在小鸟附近
    const bird = gameState.currentBird;
    const dist = Math.sqrt(Math.pow(x - bird.x, 2) + Math.pow(y - bird.y, 2));
    
    if (dist < 80) {
        gameState.isTouching = true;
        gameState.touchStartPos = { x, y };
        gameState.pullStart = { x, y };
        gameState.pullStartTime = Date.now();
        gameState.isPulling = true;
        AudioController.playPull();
        
        elements.gestureText.textContent = '拖动瞄准...';
        elements.handIcon.textContent = '👆';
    }
}

/**
 * 处理触控移动事件
 * @param {TouchEvent} e - 触控事件对象
 */
function handleTouchMove(e) {
    e.preventDefault();
    if (!gameState.isTouching || !gameState.isPulling) return;
    
    const touch = e.touches[0];
    const rect = elements.canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    gameState.pullEnd = { x, y };
    gameState.handCenter = { x, y };
    updatePullForce();
}

/**
 * 处理触控结束事件
 * @param {TouchEvent} e - 触控事件对象
 */
function handleTouchEnd(e) {
    e.preventDefault();
    if (!gameState.isTouching) return;
    
    gameState.isTouching = false;
    
    if (gameState.isPulling && gameState.canLaunch) {
        const pullDuration = Date.now() - gameState.pullStartTime;
        if (pullDuration >= gameState.minPullDuration) {
            launchBird();
        } else {
            elements.gestureText.textContent = '瞄准时间不足，请重试';
            gameState.isPulling = false;
            gameState.pullStartTime = null;
            resetBirdPosition();
        }
    }
}

/**
 * 处理鼠标按下事件(PC端备用)
 * @param {MouseEvent} e - 鼠标事件对象
 */
function handleMouseDown(e) {
    if (!gameState.canLaunch || !gameState.currentBird) return;
    
    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const bird = gameState.currentBird;
    const dist = Math.sqrt(Math.pow(x - bird.x, 2) + Math.pow(y - bird.y, 2));
    
    if (dist < 80) {
        gameState.isTouching = true;
        gameState.touchStartPos = { x, y };
        gameState.pullStart = { x, y };
        gameState.pullStartTime = Date.now();
        gameState.isPulling = true;
        AudioController.playPull();
        
        elements.gestureText.textContent = '拖动瞄准...';
        elements.handIcon.textContent = '👆';
    }
}

/**
 * 处理鼠标移动事件(PC端备用)
 * @param {MouseEvent} e - 鼠标事件对象
 */
function handleMouseMove(e) {
    if (!gameState.isTouching || !gameState.isPulling) return;
    
    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    gameState.pullEnd = { x, y };
    gameState.handCenter = { x, y };
    updatePullForce();
}

/**
 * 处理鼠标释放事件(PC端备用)
 * @param {MouseEvent} e - 鼠标事件对象
 */
function handleMouseUp(e) {
    if (!gameState.isTouching) return;
    
    gameState.isTouching = false;
    
    if (gameState.isPulling && gameState.canLaunch) {
        const pullDuration = Date.now() - gameState.pullStartTime;
        if (pullDuration >= gameState.minPullDuration) {
            launchBird();
        } else {
            elements.gestureText.textContent = '瞄准时间不足，请重试';
            gameState.isPulling = false;
            gameState.pullStartTime = null;
            resetBirdPosition();
        }
    }
}

function updateBirdsDisplay(count) {
    elements.birdsLeftDisplay.textContent = count;
    if (elements.birdsCountLarge) elements.birdsCountLarge.textContent = count;
}

/**
 * 初始化画布
 * 设置2D渲染上下文，绑定窗口resize事件，创建背景云朵
 */
function initCanvas() {
    ctx = elements.canvas.getContext('2d');
    handCtx = elements.handOverlay.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    createClouds();
    
    // 检测触控设备并初始化触控控制
    gameState.isTouchDevice = isTouchDevice();
    initTouchControls();
    
    updateLoadProgress(20);
}

/**
 * 创建背景云朵
 * 随机生成6朵云，设置不同的位置、速度、大小和透明度
 */
function createClouds() {
    gameState.clouds = [];
    for (let i = 0; i < 6; i++) {
        gameState.clouds.push({
            x: Math.random() * window.innerWidth,
            y: 50 + Math.random() * (window.innerHeight * 0.35),
            speed: 0.15 + Math.random() * 0.25,
            scale: 0.6 + Math.random() * 0.6,
            opacity: 0.5 + Math.random() * 0.3
        });
    }
}

/**
 * 响应窗口大小变化
 * 重新设置游戏画布和手势覆盖层的尺寸
 */
function resizeCanvas() {
    elements.canvas.width = window.innerWidth;
    elements.canvas.height = window.innerHeight;
    elements.handOverlay.width = elements.camera.offsetWidth || 280;
    elements.handOverlay.height = elements.camera.offsetHeight || 210;
}

/**
 * 初始化摄像头
 * 请求用户授权访问摄像头，成功后开始游戏
 * @returns {Promise<boolean>} 初始化是否成功
 */
async function initCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        gameState.cameraStream = stream;
        elements.camera.srcObject = stream;
        await elements.camera.play();
        gameState.isCameraActive = true;
        startGame();
        return true;
    } catch (error) {
        console.error('摄像头初始化失败:', error);
        elements.gestureText.textContent = '摄像头访问失败';
        return false;
    }
}

/**
 * 初始化MediaPipe Hands手势识别
 * 配置手势识别参数并设置结果回调
 */
async function initHands() {
    gameState.hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });
    gameState.hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
    });
    gameState.hands.onResults(onHandsResults);
    updateLoadProgress(30);
}

/**
 * 手势识别结果回调
 * 处理MediaPipe返回的手部关键点数据，识别右手并检测捏合手势
 * @param {Object} results - MediaPipe Hands返回的识别结果
 */
function onHandsResults(results) {
    handCtx.clearRect(0, 0, elements.handOverlay.width, elements.handOverlay.height);
    
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        let rightHandIndex = -1;
        
        if (results.multiHandedness) {
            results.multiHandedness.forEach((handedness, index) => {
                if (handedness.label === 'Left') rightHandIndex = index;
            });
        }
        
        results.multiHandLandmarks.forEach((hand, index) => {
            drawHandLandmarks(hand, index === rightHandIndex);
        });
        
        if (rightHandIndex !== -1) {
            gameState.handLandmarks = results.multiHandLandmarks[rightHandIndex];
            detectPinchGesture(gameState.handLandmarks);
        } else {
            gameState.handLandmarks = null;
            gameState.isPinching = false;
            elements.gestureText.textContent = '请使用右手操作';
            elements.handIcon.textContent = '👋';
            if (gameState.isPulling && gameState.canLaunch) launchBird();
            gameState.isPulling = false;
        }
    } else {
        gameState.handLandmarks = null;
        gameState.isPinching = false;
        elements.gestureText.textContent = '等待手势...';
        elements.handIcon.textContent = '✋';
        if (gameState.isPulling && gameState.canLaunch) launchBird();
        gameState.isPulling = false;
    }
}

/**
 * 绘制手部关键点和骨架连线
 * @param {Array} hand - 21个手部关键点数组
 * @param {boolean} isRightHand - 是否为右手(主控手)
 */
function drawHandLandmarks(hand, isRightHand = true) {
    const width = elements.handOverlay.width;
    const height = elements.handOverlay.height;
    const mainColor = isRightHand ? '#00d4ff' : '#888888';
    const tipColor = isRightHand ? '#ff6b35' : '#666666';
    
    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
        [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16],
        [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17]
    ];
    
    handCtx.strokeStyle = mainColor;
    handCtx.lineWidth = 2;
    handCtx.globalAlpha = isRightHand ? 0.8 : 0.4;
    
    connections.forEach(([i, j]) => {
        handCtx.beginPath();
        handCtx.moveTo((1 - hand[i].x) * width, hand[i].y * height);
        handCtx.lineTo((1 - hand[j].x) * width, hand[j].y * height);
        handCtx.stroke();
    });
    
    handCtx.globalAlpha = 1;
    
    hand.forEach((landmark, index) => {
        const x = (1 - landmark.x) * width;
        const y = landmark.y * height;
        const fingerTips = [4, 8, 12, 16, 20];
        const isFingerTip = fingerTips.includes(index);
        const radius = isFingerTip ? 6 : 3;
        const color = isFingerTip ? tipColor : mainColor;
        
        if (isRightHand) {
            const gradient = handCtx.createRadialGradient(x, y, 0, x, y, radius + 5);
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, 'transparent');
            handCtx.fillStyle = gradient;
            handCtx.beginPath();
            handCtx.arc(x, y, radius + 5, 0, Math.PI * 2);
            handCtx.fill();
        }
        
        handCtx.beginPath();
        handCtx.arc(x, y, radius, 0, Math.PI * 2);
        handCtx.fillStyle = color;
        handCtx.globalAlpha = isRightHand ? 1 : 0.5;
        handCtx.fill();
        handCtx.globalAlpha = 1;
    });
    
    if (isRightHand) {
        const thumb = hand[4], index = hand[8];
        const thumbX = (1 - thumb.x) * width, thumbY = thumb.y * height;
        const indexX = (1 - index.x) * width, indexY = index.y * height;
        
        handCtx.strokeStyle = gameState.isPinching ? '#00ff88' : '#ff6b35';
        handCtx.lineWidth = 3;
        handCtx.setLineDash([5, 5]);
        handCtx.beginPath();
        handCtx.moveTo(thumbX, thumbY);
        handCtx.lineTo(indexX, indexY);
        handCtx.stroke();
        handCtx.setLineDash([]);
        
        handCtx.fillStyle = '#00ff88';
        handCtx.font = '10px Arial';
        handCtx.fillText('右手', (1 - hand[0].x) * width - 15, hand[0].y * height + 20);
    }
}

/**
 * 检测捏合手势
 * 计算拇指和食指距离，判断是否形成捏合，控制小鸟瞄准和发射
 * @param {Array} hand - 手部关键点数组
 */
function detectPinchGesture(hand) {
    const thumb = hand[4], index = hand[8];
    const distance = Math.sqrt(Math.pow(thumb.x - index.x, 2) + Math.pow(thumb.y - index.y, 2));
    
    gameState.pinchDistance = distance;
    gameState.handCenter = {
        x: (1 - ((thumb.x + index.x) / 2)) * elements.canvas.width,
        y: ((thumb.y + index.y) / 2) * elements.canvas.height
    };
    
    const pinchThreshold = 0.10;
    const wasPinching = gameState.isPinching;
    const isNowPinching = distance < pinchThreshold;
    
    if (gameState.needsHandReset) {
        if (!isNowPinching) {
            gameState.needsHandReset = false;
            elements.gestureText.textContent = '手势已重置，请捏合';
        } else {
            elements.gestureText.textContent = '请先松开手指重置手势';
            elements.handIcon.textContent = '✋';
            return;
        }
    }
    
    gameState.isPinching = isNowPinching;
    
    if (gameState.isPinching) {
        elements.gestureText.textContent = '捏合中 - 拉动发射！';
        elements.handIcon.textContent = '🤏';
        
        if (gameState.canLaunch && gameState.currentBird) {
            if (!gameState.isPulling) {
                gameState.isPulling = true;
                gameState.pullStart = { ...gameState.handCenter };
                gameState.pullStartTime = Date.now();
                AudioController.playPull();
            }
            gameState.pullEnd = { ...gameState.handCenter };
            updatePullForce();
        }
    } else {
        elements.gestureText.textContent = '张开手指瞄准';
        elements.handIcon.textContent = '✋';
        
        if (wasPinching && gameState.isPulling && gameState.canLaunch) {
            const pullDuration = Date.now() - gameState.pullStartTime;
            if (pullDuration >= gameState.minPullDuration) {
                launchBird();
            } else {
                elements.gestureText.textContent = '瞄准时间不足，请重试';
                gameState.isPulling = false;
                gameState.pullStartTime = null;
                resetBirdPosition();
            }
        } else if (gameState.isPulling) {
            gameState.isPulling = false;
            gameState.pullStartTime = null;
            resetBirdPosition();
        }
    }
}

/**
 * 重置小鸟位置到弹弓原点
 * 当瞄准时间不足或取消发射时调用
 */
function resetBirdPosition() {
    if (gameState.currentBird) {
        gameState.currentBird.x = elements.canvas.width * SLINGSHOT_X_RATIO;
        gameState.currentBird.y = elements.canvas.height * SLINGSHOT_Y_RATIO;
        elements.powerFill.style.width = '0%';
        elements.powerValue.textContent = '0%';
    }
}

/**
 * 更新拉动力度
 * 根据拉动距离计算发射速度，更新小鸟位置和力量条显示
 */
function updatePullForce() {
    if (!gameState.pullStart || !gameState.pullEnd) return;
    
    const pullDx = gameState.pullEnd.x - gameState.pullStart.x;
    const pullDy = gameState.pullEnd.y - gameState.pullStart.y;
    const distance = Math.min(Math.sqrt(pullDx * pullDx + pullDy * pullDy), MAX_PULL_DISTANCE);
    const power = (distance / MAX_PULL_DISTANCE) * 100;
    
    elements.powerFill.style.width = power + '%';
    
    if (gameState.pullStartTime) {
        const elapsed = Date.now() - gameState.pullStartTime;
        const remaining = Math.max(0, gameState.minPullDuration - elapsed);
        if (remaining > 0) {
            elements.powerValue.textContent = (remaining / 1000).toFixed(1) + 's';
            elements.gestureText.textContent = `瞄准中... ${(remaining / 1000).toFixed(1)}s后可发射`;
        } else {
            elements.powerValue.textContent = Math.round(power) + '%';
            elements.gestureText.textContent = '松开手指发射！';
        }
    } else {
        elements.powerValue.textContent = Math.round(power) + '%';
    }
    
    let vx = -pullDx * LAUNCH_POWER_MULTIPLIER;
    let vy = -pullDy * LAUNCH_POWER_MULTIPLIER;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > MAX_LAUNCH_SPEED) {
        const scale = MAX_LAUNCH_SPEED / speed;
        vx *= scale;
        vy *= scale;
    }
    gameState.launchVelocity = { x: vx, y: vy };
    
    const slingshotX = elements.canvas.width * SLINGSHOT_X_RATIO;
    const slingshotY = elements.canvas.height * SLINGSHOT_Y_RATIO;
    if (gameState.currentBird) {
        const pullRatio = Math.min(distance / MAX_PULL_DISTANCE, 1);
        gameState.currentBird.x = slingshotX + pullDx * pullRatio * 0.5;
        gameState.currentBird.y = slingshotY + pullDy * pullRatio * 0.5;
    }
    
    calculateTrajectory();
}

/**
 * 计算弹道轨迹预测
 * 基于当前发射速度模拟小鸟飞行路径，用于显示瞄准辅助线
 */
function calculateTrajectory() {
    gameState.trajectory = [];
    if (!gameState.launchVelocity || gameState.launchVelocity.x === 0) return;
    
    let x = elements.canvas.width * SLINGSHOT_X_RATIO;
    let y = elements.canvas.height * SLINGSHOT_Y_RATIO;
    let vx = gameState.launchVelocity.x;
    let vy = gameState.launchVelocity.y;
    
    for (let i = 0; i < 50; i++) {
        gameState.trajectory.push({ x, y });
        vx *= FRICTION;
        vy *= FRICTION;
        vy += GRAVITY;
        x += vx;
        y += vy;
        if (y > elements.canvas.height * GROUND_Y_RATIO || x < 0) break;
    }
}

/**
 * 发射小鸟
 * 将计算好的速度赋予小鸟，标记为已发射状态，播放音效
 */
function launchBird() {
    if (!gameState.currentBird || !gameState.canLaunch) return;
    
    gameState.currentBird.vx = gameState.launchVelocity.x;
    gameState.currentBird.vy = gameState.launchVelocity.y;
    gameState.currentBird.isLaunched = true;
    
    AudioController.playLaunch();
    
    gameState.isPulling = false;
    gameState.pullStartTime = null;
    gameState.canLaunch = false;
    gameState.needsHandReset = true;
    gameState.trajectory = [];
    
    elements.powerFill.style.width = '0%';
    elements.powerValue.textContent = '0%';
    
    gameState.birdsLeft--;
    updateBirdsDisplay(gameState.birdsLeft);
}

/**
 * 开始游戏
 * 初始化游戏状态，加载当前关卡
 */
function startGame() {
    gameState.isPlaying = true;
    gameState.score = 0;
    
    const levelIndex = (gameState.level - 1) % LEVEL_DEFINITIONS.length;
    gameState.birdsLeft = LEVEL_DEFINITIONS[levelIndex].birds || 5;
    
    elements.scoreDisplay.textContent = '0';
    updateBirdsDisplay(gameState.birdsLeft);
    elements.restartBtn.classList.remove('hidden');
    
    loadLevel(gameState.level);
}

/**
 * 加载关卡
 * 根据关卡定义创建猪和木块，使用物理世界系统自动堆叠
 * @param {number} levelNum - 关卡编号
 */
function loadLevel(levelNum) {
    const levelIndex = (levelNum - 1) % LEVEL_DEFINITIONS.length;
    const levelData = LEVEL_DEFINITIONS[levelIndex];
    
    gameState.pigs = [];
    gameState.blocks = [];
    gameState.canLaunch = true;
    
    const physicsWorld = new PhysicsWorld(elements.canvas.width, elements.canvas.height);
    const { pigs, blocks } = physicsWorld.processLevel(levelData.objects);
    
    gameState.pigs = pigs;
    gameState.blocks = blocks;
    
    spawnBird();
    elements.levelDisplay.textContent = levelNum;
}

/**
 * 生成新小鸟
 * 在弹弓位置创建待发射的小鸟，重置发射状态
 */
function spawnBird() {
    gameState.currentBird = {
        x: elements.canvas.width * SLINGSHOT_X_RATIO,
        y: elements.canvas.height * SLINGSHOT_Y_RATIO,
        radius: 22, vx: 0, vy: 0, isLaunched: false, color: '#ff4444'
    };
    gameState.canLaunch = true;
    gameState.isPulling = false;
    gameState.pullStart = null;
    gameState.pullEnd = null;
    gameState.launchVelocity = { x: 0, y: 0 };
    gameState.trajectory = [];
    elements.powerFill.style.width = '0%';
    elements.powerValue.textContent = '0%';
}

/**
 * 更新物理模拟
 * 处理小鸟飞行、重力、碰撞检测、伤害计算和物体运动
 */
function updatePhysics() {
    if (gameState.currentBird && gameState.currentBird.isLaunched) {
        const bird = gameState.currentBird;
        bird.vx *= FRICTION;
        bird.vy *= FRICTION;
        bird.vy += GRAVITY;
        bird.x += bird.vx;
        bird.y += bird.vy;
        
        const groundY = elements.canvas.height * GROUND_Y_RATIO;
        if (bird.y + bird.radius > groundY) {
            bird.y = groundY - bird.radius;
            bird.vy *= -0.5;
            bird.vx *= 0.8;
            if (Math.abs(bird.vx) < 0.5 && Math.abs(bird.vy) < 0.5) birdStopped();
        }
        
        if (bird.x > elements.canvas.width + 100 || bird.x < -100) birdStopped();
        
        for (let i = gameState.pigs.length - 1; i >= 0; i--) {
            const pig = gameState.pigs[i];
            if (checkCircleCollision(bird, pig)) {
                pig.health -= 30;
                pig.vx += bird.vx * 0.3;
                pig.vy += bird.vy * 0.3;
                createParticles(pig.x, pig.y, '#00ff00', 10);
                if (pig.health <= 0) {
                    gameState.pigs.splice(i, 1);
                    gameState.score += 500;
                    elements.scoreDisplay.textContent = gameState.score;
                    createParticles(pig.x, pig.y, '#00ff00', 20);
                }
                bird.vx *= 0.7;
                bird.vy *= 0.7;
            }
        }
        
        for (let i = gameState.blocks.length - 1; i >= 0; i--) {
            const block = gameState.blocks[i];
            if (checkCircleRectCollision(bird, block)) {
                const damage = Math.sqrt(bird.vx * bird.vx + bird.vy * bird.vy) * 2;
                block.health -= damage;
                block.vx += bird.vx * 0.2;
                block.vy += bird.vy * 0.2;
                createParticles(bird.x, bird.y, block.type === 'stone' ? '#888' : '#8B4513', 5);
                if (block.health <= 0) {
                    gameState.blocks.splice(i, 1);
                    gameState.score += 100;
                    elements.scoreDisplay.textContent = gameState.score;
                    createParticles(block.x, block.y, block.type === 'stone' ? '#888' : '#8B4513', 15);
                }
                bird.vx *= -0.5;
                bird.vy *= 0.8;
            }
        }
    }
    
    const groundY = elements.canvas.height * GROUND_Y_RATIO;
    
    gameState.pigs.forEach(pig => {
        pig.vx *= 0.95;
        pig.vy *= 0.95;
        pig.vy += GRAVITY * 0.5;
        pig.x += pig.vx;
        pig.y += pig.vy;
        if (pig.y + pig.radius > groundY) {
            pig.y = groundY - pig.radius;
            pig.vy *= -0.3;
        }
    });
    
    gameState.blocks.forEach(block => {
        block.vx *= 0.95;
        block.vy *= 0.95;
        block.vy += GRAVITY * 0.3;
        block.x += block.vx;
        block.y += block.vy;
        if (block.y + block.height / 2 > groundY) {
            block.y = groundY - block.height / 2;
            block.vy *= -0.2;
        }
    });
    
    gameState.particles = gameState.particles.filter(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.2;
        p.life--;
        return p.life > 0;
    });
}

/**
 * 小鸟停止移动回调
 * 检查游戏状态：消灭所有猪则过关，小鸟用完则失败，否则生成新小鸟
 */
function birdStopped() {
    gameState.currentBird = null;
    setTimeout(() => {
        if (gameState.pigs.length === 0) levelComplete();
        else if (gameState.birdsLeft <= 0) gameOver();
        else spawnBird();
    }, 500);
}

/**
 * 检测两个圆形物体碰撞
 * @param {Object} c1 - 圆形物体1 {x, y, radius}
 * @param {Object} c2 - 圆形物体2 {x, y, radius}
 * @returns {boolean} 是否发生碰撞
 */
function checkCircleCollision(c1, c2) {
    const dx = c1.x - c2.x, dy = c1.y - c2.y;
    return Math.sqrt(dx * dx + dy * dy) < c1.radius + c2.radius;
}

/**
 * 检测圆形与矩形碰撞
 * @param {Object} circle - 圆形物体 {x, y, radius}
 * @param {Object} rect - 矩形物体 {x, y, width, height}
 * @returns {boolean} 是否发生碰撞
 */
function checkCircleRectCollision(circle, rect) {
    const closestX = Math.max(rect.x - rect.width / 2, Math.min(circle.x, rect.x + rect.width / 2));
    const closestY = Math.max(rect.y - rect.height / 2, Math.min(circle.y, rect.y + rect.height / 2));
    const dx = circle.x - closestX, dy = circle.y - closestY;
    return (dx * dx + dy * dy) < (circle.radius * circle.radius);
}

/**
 * 创建粒子特效
 * @param {number} x - 粒子生成X坐标
 * @param {number} y - 粒子生成Y坐标
 * @param {string} color - 粒子颜色
 * @param {number} count - 粒子数量
 */
function createParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
        gameState.particles.push({
            x, y,
            vx: (Math.random() - 0.5) * 10,
            vy: (Math.random() - 0.5) * 10 - 5,
            radius: Math.random() * 5 + 2,
            color,
            life: 30 + Math.random() * 20
        });
    }
}

/**
 * 关卡完成处理
 * 计算星级评分，显示胜利弹窗
 */
function levelComplete() {
    gameState.isPlaying = false;
    gameState.levelPassed = true;
    const levelIndex = (gameState.level - 1) % LEVEL_DEFINITIONS.length;
    const totalBirds = LEVEL_DEFINITIONS[levelIndex].birds || 5;
    const usedBirds = totalBirds - gameState.birdsLeft;
    
    let stars = usedBirds <= Math.ceil(totalBirds * 0.3) ? 3 :
                usedBirds <= Math.ceil(totalBirds * 0.6) ? 2 : 1;
    
    elements.modalTitle.textContent = 'LEVEL COMPLETE!';
    elements.modalScore.textContent = gameState.score;
    elements.modalStars.querySelectorAll('.star').forEach((star, i) => {
        star.classList.toggle('active', i < stars);
    });
    elements.gameModal.classList.remove('hidden');
    elements.retryBtn.classList.remove('hidden');
    elements.modalNextBtn.classList.remove('hidden');
    if (elements.modalHint) elements.modalHint.textContent = '按 Space 键进入下一关';
}

/**
 * 游戏失败处理
 * 显示失败弹窗
 */
function gameOver() {
    gameState.isPlaying = false;
    gameState.levelPassed = false;
    elements.modalTitle.textContent = 'GAME OVER';
    elements.modalScore.textContent = gameState.score;
    elements.modalStars.querySelectorAll('.star').forEach(star => star.classList.remove('active'));
    elements.gameModal.classList.remove('hidden');
    elements.retryBtn.classList.remove('hidden');
    elements.modalNextBtn.classList.add('hidden');
    if (elements.modalHint) elements.modalHint.textContent = '按 Space 键重试';
}

function updateClouds() {
    gameState.clouds.forEach(cloud => {
        cloud.x += cloud.speed;
        if (cloud.x > elements.canvas.width + 150) {
            cloud.x = -150;
            cloud.y = 50 + Math.random() * (window.innerHeight * 0.35);
        }
    });
}

function drawClouds() {
    gameState.clouds.forEach(cloud => {
        const s = cloud.scale;
        ctx.save();
        ctx.globalAlpha = cloud.opacity;
        
        if (images.loaded && images.cloud) {
            // 使用素材图绘制云朵，缩放到合适大小
            const cloudWidth = 120 * s;
            const cloudHeight = (images.cloud.height / images.cloud.width) * cloudWidth;
            ctx.drawImage(
                images.cloud,
                cloud.x - cloudWidth / 2,
                cloud.y - cloudHeight / 2,
                cloudWidth,
                cloudHeight
            );
        } else {
            // 备用绘制方式
            ctx.fillStyle = 'rgba(200, 220, 240, 0.3)';
            ctx.beginPath();
            ctx.ellipse(cloud.x + 5, cloud.y + 8 * s, 45 * s, 18 * s, 0, 0, Math.PI * 2);
            ctx.fill();
            
            const gradient = ctx.createRadialGradient(cloud.x, cloud.y - 10 * s, 0, cloud.x, cloud.y, 60 * s);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
            gradient.addColorStop(0.5, 'rgba(245, 250, 255, 0.95)');
            gradient.addColorStop(1, 'rgba(220, 235, 250, 0.8)');
            ctx.fillStyle = gradient;
            
            [[0, 0, 40, 25], [-35, 5, 30, 20], [35, 5, 30, 20], [-18, -15, 28, 22], [18, -15, 28, 22], [0, -22, 25, 18]].forEach(([dx, dy, rx, ry]) => {
                ctx.beginPath();
                ctx.ellipse(cloud.x + dx * s, cloud.y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
                ctx.fill();
            });
        }
        
        ctx.restore();
    });
}

/**
 * 渲染游戏画面
 * 绘制背景、云朵、弹弓、轨迹、木块、猪、小鸟和粒子
 */
function render() {
    ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
    drawBackground();
    drawClouds();
    drawSlingshot();
    drawTrajectory();
    gameState.blocks.forEach(drawBlock);
    gameState.pigs.forEach(drawPig);
    if (gameState.currentBird) drawBird(gameState.currentBird);
    gameState.particles.forEach(drawParticle);
    if (gameState.isPulling && gameState.currentBird) drawPullLine();
}

function drawBackground() {
    const skyGradient = ctx.createLinearGradient(0, 0, 0, elements.canvas.height);
    skyGradient.addColorStop(0, '#1a2a3a');
    skyGradient.addColorStop(0.7, '#2d4a5a');
    skyGradient.addColorStop(1, '#3d5a6a');
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
    
    const groundY = elements.canvas.height * GROUND_Y_RATIO;
    const groundGradient = ctx.createLinearGradient(0, groundY, 0, elements.canvas.height);
    groundGradient.addColorStop(0, '#4a7c59');
    groundGradient.addColorStop(1, '#2d5a3d');
    ctx.fillStyle = groundGradient;
    ctx.fillRect(0, groundY, elements.canvas.width, elements.canvas.height - groundY);
    
    ctx.strokeStyle = '#6a9c79';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(elements.canvas.width, groundY);
    ctx.stroke();
}

function drawSlingshot() {
    const baseY = elements.canvas.height * GROUND_Y_RATIO;
    const slingshotX = elements.canvas.width * SLINGSHOT_X_RATIO;
    const slingshotY = elements.canvas.height * SLINGSHOT_Y_RATIO;
    
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    
    ctx.beginPath();
    ctx.moveTo(slingshotX - 25, baseY);
    ctx.lineTo(slingshotX - 18, slingshotY - 35);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(slingshotX + 25, baseY);
    ctx.lineTo(slingshotX + 18, slingshotY - 35);
    ctx.stroke();
    
    if (gameState.isPulling && gameState.currentBird) {
        ctx.strokeStyle = '#654321';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(slingshotX - 18, slingshotY - 35);
        ctx.lineTo(gameState.currentBird.x, gameState.currentBird.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(slingshotX + 18, slingshotY - 35);
        ctx.lineTo(gameState.currentBird.x, gameState.currentBird.y);
        ctx.stroke();
    }
}

function drawTrajectory() {
    if (gameState.trajectory.length < 2) return;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    gameState.trajectory.forEach((point, i) => {
        ctx.globalAlpha = (1 - (i / gameState.trajectory.length)) * 0.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1;
}

function drawBird(bird) {
    if (images.loaded && images.bird) {
        // 使用素材图绘制小鸟，根据半径缩放
        const birdSize = bird.radius * 2.2;
        ctx.save();
        
        // 如果小鸟已发射，根据速度方向旋转
        if (bird.isLaunched && (bird.vx !== 0 || bird.vy !== 0)) {
            const angle = Math.atan2(bird.vy, bird.vx);
            ctx.translate(bird.x, bird.y);
            ctx.rotate(angle);
            ctx.drawImage(
                images.bird,
                -birdSize / 2,
                -birdSize / 2,
                birdSize,
                birdSize
            );
        } else {
            ctx.drawImage(
                images.bird,
                bird.x - birdSize / 2,
                bird.y - birdSize / 2,
                birdSize,
                birdSize
            );
        }
        
        ctx.restore();
    } else {
        // 备用绘制方式
        ctx.beginPath();
        ctx.arc(bird.x, bird.y, bird.radius, 0, Math.PI * 2);
        const gradient = ctx.createRadialGradient(bird.x - 5, bird.y - 5, 0, bird.x, bird.y, bird.radius);
        gradient.addColorStop(0, '#ff6666');
        gradient.addColorStop(1, '#cc0000');
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = '#990000';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(bird.x - 6, bird.y - 5, 6, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(bird.x + 6, bird.y - 5, 6, 7, 0, 0, Math.PI * 2); ctx.fill();
        
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(bird.x - 4, bird.y - 4, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(bird.x + 8, bird.y - 4, 3, 0, Math.PI * 2); ctx.fill();
        
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(bird.x - 12, bird.y - 12); ctx.lineTo(bird.x - 2, bird.y - 8); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bird.x + 12, bird.y - 12); ctx.lineTo(bird.x + 2, bird.y - 8); ctx.stroke();
        
        ctx.fillStyle = '#ff9900';
        ctx.beginPath();
        ctx.moveTo(bird.x + bird.radius - 5, bird.y + 2);
        ctx.lineTo(bird.x + bird.radius + 10, bird.y + 5);
        ctx.lineTo(bird.x + bird.radius - 5, bird.y + 8);
        ctx.closePath();
        ctx.fill();
    }
}

function drawPig(pig) {
    if (images.loaded && images.pig) {
        // 使用素材图绘制猪，根据半径缩放
        const pigSize = pig.radius * 2.2;
        ctx.drawImage(
            images.pig,
            pig.x - pigSize / 2,
            pig.y - pigSize / 2,
            pigSize,
            pigSize
        );
    } else {
        // 备用绘制方式
        ctx.beginPath();
        ctx.arc(pig.x, pig.y, pig.radius, 0, Math.PI * 2);
        const gradient = ctx.createRadialGradient(pig.x - 5, pig.y - 5, 0, pig.x, pig.y, pig.radius);
        gradient.addColorStop(0, '#90EE90');
        gradient.addColorStop(1, '#228B22');
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = '#006400';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.fillStyle = '#32CD32';
        ctx.beginPath(); ctx.ellipse(pig.x, pig.y + 2, pig.radius * 0.4, pig.radius * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#228B22'; ctx.stroke();
        
        ctx.fillStyle = '#006400';
        ctx.beginPath(); ctx.arc(pig.x - 4, pig.y + 2, 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(pig.x + 4, pig.y + 2, 2, 0, Math.PI * 2); ctx.fill();
        
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(pig.x - 8, pig.y - 8, 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(pig.x + 8, pig.y - 8, 6, 0, Math.PI * 2); ctx.fill();
        
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(pig.x - 8, pig.y - 8, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(pig.x + 8, pig.y - 8, 3, 0, Math.PI * 2); ctx.fill();
        
        ctx.fillStyle = '#90EE90';
        ctx.beginPath(); ctx.ellipse(pig.x - pig.radius + 5, pig.y - pig.radius + 5, 8, 6, -0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(pig.x + pig.radius - 5, pig.y - pig.radius + 5, 8, 6, 0.5, 0, Math.PI * 2); ctx.fill();
    }
}

function drawBlock(block) {
    const x = block.x - block.width / 2;
    const y = block.y - block.height / 2;
    
    const gradient = ctx.createLinearGradient(x, y, x + block.width, y + block.height);
    if (block.type === 'wood') {
        gradient.addColorStop(0, '#DEB887');
        gradient.addColorStop(0.5, '#D2691E');
        gradient.addColorStop(1, '#8B4513');
    } else {
        gradient.addColorStop(0, '#A9A9A9');
        gradient.addColorStop(0.5, '#808080');
        gradient.addColorStop(1, '#696969');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, block.width, block.height);
    
    ctx.strokeStyle = block.type === 'wood' ? '#654321' : '#404040';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, block.width, block.height);
    
    const healthRatio = block.health / (block.type === 'stone' ? 100 : 50);
    if (healthRatio < 0.7) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + block.width * 0.3, y);
        ctx.lineTo(x + block.width * 0.5, y + block.height * 0.4);
        ctx.lineTo(x + block.width * 0.7, y + block.height);
        ctx.stroke();
    }
}

function drawParticle(particle) {
    ctx.globalAlpha = particle.life / 50;
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
}

function drawPullLine() {
    if (!gameState.pullStart || !gameState.pullEnd) return;
    
    const bird = gameState.currentBird;
    const dx = gameState.pullStart.x - gameState.pullEnd.x;
    const dy = gameState.pullStart.y - gameState.pullEnd.y;
    
    ctx.strokeStyle = 'rgba(255, 107, 53, 0.5)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(bird.x, bird.y);
    ctx.lineTo(bird.x + dx, bird.y + dy);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const angle = Math.atan2(dy, dx);
    const arrowLength = 15;
    ctx.fillStyle = 'rgba(255, 107, 53, 0.8)';
    ctx.beginPath();
    ctx.moveTo(bird.x + dx, bird.y + dy);
    ctx.lineTo(bird.x + dx - arrowLength * Math.cos(angle - 0.3), bird.y + dy - arrowLength * Math.sin(angle - 0.3));
    ctx.lineTo(bird.x + dx - arrowLength * Math.cos(angle + 0.3), bird.y + dy - arrowLength * Math.sin(angle + 0.3));
    ctx.closePath();
    ctx.fill();
}

/**
 * 游戏主循环
 * 每帧执行：手势识别、物理更新、画面渲染
 */
async function gameLoop() {
    if (gameState.isLoaded) {
        if (gameState.isCameraActive && gameState.hands && elements.camera.readyState >= 2) {
            await gameState.hands.send({ image: elements.camera });
        }
        updateClouds();
        if (gameState.isPlaying) updatePhysics();
        render();
    }
    requestAnimationFrame(gameLoop);
}

function restartGame() {
    elements.gameModal.classList.add('hidden');
    gameState.score = 0;
    const levelIndex = (gameState.level - 1) % LEVEL_DEFINITIONS.length;
    gameState.birdsLeft = LEVEL_DEFINITIONS[levelIndex].birds || 5;
    elements.scoreDisplay.textContent = '0';
    updateBirdsDisplay(gameState.birdsLeft);
    loadLevel(gameState.level);
    gameState.isPlaying = true;
}

function nextLevel() {
    elements.gameModal.classList.add('hidden');
    gameState.level++;
    const levelIndex = (gameState.level - 1) % LEVEL_DEFINITIONS.length;
    gameState.birdsLeft = LEVEL_DEFINITIONS[levelIndex].birds || 5;
    updateBirdsDisplay(gameState.birdsLeft);
    loadLevel(gameState.level);
    gameState.isPlaying = true;
}

/**
 * 游戏初始化入口
 * 依次初始化画布、图片、手势识别、事件监听，启动游戏循环
 */
async function init() {
    initCanvas();
    await loadImages();
    updateLoadProgress(20);
    await initHands();
    updateLoadProgress(50);
    
    elements.restartBtn.addEventListener('click', restartGame);
    elements.nextBtn.addEventListener('click', nextLevel);
    elements.retryBtn.addEventListener('click', restartGame);
    elements.modalNextBtn.addEventListener('click', nextLevel);
    
    // Space键支持
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !elements.gameModal.classList.contains('hidden')) {
            e.preventDefault();
            if (gameState.levelPassed) {
                nextLevel();
            } else {
                restartGame();
            }
        }
    });
    
    gameLoop();
    await initCamera();
}

init().catch(error => {
    console.error('Initialization failed:', error);
    elements.loadingScreen.innerHTML = `
        <div class="loading-content">
            <div class="loading-bird">😢</div>
            <div class="loading-text" style="color: #ff6b35;">LOAD FAILED</div>
            <div style="color: #00d4ff; margin-top: 20px; font-size: 12px;">Please refresh and try again.</div>
        </div>
    `;
});

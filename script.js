window.addEventListener('load', () => {
    const performanceDelay = navigator.hardwareConcurrency < 4 ? 800 : 500;
    setTimeout(initializeOptimizedShaders, performanceDelay);
});

function initializeOptimizedShaders() {
    if (typeof THREE === 'undefined') { console.error("Shader Error: Three.js missing."); return; }
    
    const perfConfig = { 
        maxInstances: 8,
        isMobile: /Mobi/i.test(navigator.userAgent),
        resolutionScale: 0.75,
        renderBudget: 40,
        targetFPS: 30
    };
    
    let instanceCount = 0;
    const activeInstances = new Set();
    let lastGlobalTime = 0;
    let frameStartTime = 0;
    let renderBudgetExceeded = false;
    
    function globalAnimate(currentTime) { 
        requestAnimationFrame(globalAnimate);
        if (currentTime - lastGlobalTime < 33) return;
        frameStartTime = performance.now();
        renderBudgetExceeded = false;
        let renderedCount = 0;
        for (const instance of activeInstances) {
            if (renderBudgetExceeded) break;
            const renderStart = performance.now();
            instance.update(currentTime);
            const renderDuration = performance.now() - renderStart;
            renderedCount++;
            if (performance.now() - frameStartTime > perfConfig.renderBudget) {
                renderBudgetExceeded = true;
                break;
            }
        }
        lastGlobalTime = currentTime;
    }
    requestAnimationFrame(globalAnimate);

    function generateColumnBoundaries(num, variation, seed) { 
        const boundaries = [0.0]; let totalWeight = 0; const weights = []; 
        for (let i = 0; i < num; i++) { 
            seed = (seed * 1664525 + 1013904223) % 4294967296; const random = (seed / 4294967296); 
            weights.push(Math.max(0.1, 1.0 + (random - 0.5) * variation)); totalWeight += weights[i]; 
        } 
        let pos = 0; 
        for (let i = 0; i < weights.length - 1; i++) { pos += weights[i] / totalWeight; boundaries.push(pos); } 
        boundaries.push(1.0); return boundaries; 
    }
    
function generateLookupTexture(boundaries, width = 512) {
    const data = new Uint8Array(width * 4); let boundaryIndex = 0; 
    for (let i = 0; i < width; i++) { 
        const u = i / (width - 1); 
        while (boundaryIndex < boundaries.length - 2 && u >= boundaries[boundaryIndex + 1]) { boundaryIndex++; } 
        data[i * 4] = boundaryIndex; data[i * 4 + 3] = 255; 
    } 
    const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat); 
    texture.needsUpdate = true; return texture; 
}

// Background image loading functions
function createFallbackTexture() {
    const size = 256;
    const data = new Uint8Array(size * size * 3);
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            const idx = (i * size + j) * 3;
            const x = i / size; const y = j / size;
            data[idx] = Math.sin(x * Math.PI) * 255;
            data[idx + 1] = Math.sin(y * Math.PI * 2) * 255;
            data[idx + 2] = Math.sin((x + y) * Math.PI) * 255;
        }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBFormat);
    texture.needsUpdate = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
}

function loadBackgroundTexture(imageUrl) {
    return new Promise((resolve) => {
        if (!imageUrl) { resolve(null); return; }
        const testImg = new Image();
        testImg.crossOrigin = 'anonymous';
        testImg.onload = function() {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            loader.load(imageUrl, (texture) => {
                texture.wrapS = THREE.ClampToEdgeWrapping;
                texture.wrapT = THREE.ClampToEdgeWrapping;
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                resolve(texture);
            }, undefined, () => resolve(createFallbackTexture()));
        };
        testImg.onerror = () => resolve(createFallbackTexture());
        testImg.src = imageUrl;
    });
}

// NEW: Create blurred texture once during initialization
function createBlurredTexture(originalTexture) {
    return new Promise((resolve) => {
        if (!originalTexture) {
            resolve(null);
            return;
        }
        
        // Create a temporary scene to render the blur
        const blurScene = new THREE.Scene();
        const blurCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
        const blurRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
        
        const blurSize = 512; // Fixed size for blur texture
        blurRenderer.setSize(blurSize, blurSize);
        
        const blurMaterial = new THREE.ShaderMaterial({
            uniforms: {
                u_texture: { value: originalTexture },
                u_resolution: { value: new THREE.Vector2(blurSize, blurSize) }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D u_texture;
                uniform vec2 u_resolution;
                varying vec2 vUv;
                
                vec3 fastGaussianBlur(sampler2D tex, vec2 uv) {
                    vec3 result = vec3(0.0);
                    float totalWeight = 0.0;
                    vec2 texelSize = 1.0 / u_resolution;
                    
                    // 3x3 blur - only 9 samples
                    for (int x = -1; x <= 1; x++) {
                        for (int y = -1; y <= 1; y++) {
                            vec2 offset = vec2(float(x), float(y));
                            float weight = 1.0 / (1.0 + dot(offset, offset));
                            vec2 sampleUV = clamp(uv + offset * texelSize, vec2(0.0), vec2(1.0));
                            result += texture2D(tex, sampleUV).rgb * weight;
                            totalWeight += weight;
                        }
                    }
                    return result / totalWeight;
                }
                
                void main() {
                    vec3 blurred = fastGaussianBlur(u_texture, vUv);
                    gl_FragColor = vec4(blurred * 0.85, 1.0); // Slight dimming
                }
            `
        });
        
        const blurPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blurMaterial);
        blurScene.add(blurPlane);
        
        // Render to texture
        const renderTarget = new THREE.WebGLRenderTarget(blurSize, blurSize, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping
        });
        
        blurRenderer.setRenderTarget(renderTarget);
        blurRenderer.render(blurScene, blurCamera);
        blurRenderer.setRenderTarget(null);
        
        // Clean up temporary objects
        blurRenderer.dispose();
        blurMaterial.dispose();
        blurPlane.geometry.dispose();
        blurScene.remove(blurPlane);
        
        resolve(renderTarget.texture);
    });
}

async function initShader_StepByStep(container, onComplete) {
    const state = {};
    const runStep = async (step) => {
        try {
            switch(step) {
                case 0:
                    instanceCount++; 
                    state.isLowQuality = perfConfig.isMobile || instanceCount > 2;
                    const p = container.getAttribute('data-width-preset') || 'balanced'; 
                    const ps = { 'balanced': { c: 5, v: 1.0, d: 0.2 }, 'extremes': { c: 4, v: 1.8, d: 0.15 }, 'minimal': { c: 3, v: 1.5, d: 0.1 }, 'dense': { c: 7, v: 0.8, d: 0.25 } }; 
                    const c = ps[p] || ps['balanced'];
                    state.settings = { 
                        columns: parseInt(container.getAttribute('data-columns')) || c.c, 
                        noise: parseFloat(container.getAttribute('data-noise')) || (state.isLowQuality ? 0.015 : 0.035),
                        distortion: parseFloat(container.getAttribute('data-distortion')) || (c.d * 1.5), 
                        widthVariation: parseFloat(container.getAttribute('data-width-variation')) || c.v, 
                        sensitivityOne: parseFloat(container.getAttribute('data-sensitivity-one')) || 0.08,
                        sensitivityTwo: parseFloat(container.getAttribute('data-sensitivity-two')) || 0.05, 
                        sensitivityThree: parseFloat(container.getAttribute('data-sensitivity-three')) || 0.1,
                        hoverEnabled: container.getAttribute('data-hover') !== 'false',
                        backgroundImage: container.getAttribute('data-background-image') || null
                    };
                    const boundaries = generateColumnBoundaries(state.settings.columns, state.settings.widthVariation, parseInt(container.getAttribute('data-seed')) || 1234);
                    state.lookupTexture = generateLookupTexture(boundaries); 
                    
                    // Load original background texture
                    state.backgroundTexture = await loadBackgroundTexture(state.settings.backgroundImage);
                    
                    // NEW: Pre-blur the background texture once
                    console.log('Creating blurred texture...');
                    state.blurredBackgroundTexture = await createBlurredTexture(state.backgroundTexture);
                    console.log('Blurred texture created successfully!');
                    
                    setTimeout(() => runStep(1), 20);
                    break;
                    
                case 1:
                    state.scene = new THREE.Scene(); 
                    state.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
                    state.renderer = new THREE.WebGLRenderer({ 
                        alpha: true, 
                        antialias: false,
                        powerPreference: "high-performance",
                        precision: "lowp",
                        stencil: false,
                        depth: false,
                        premultipliedAlpha: false
                    });
                    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
                    const { clientWidth, clientHeight } = container;
                    state.renderer.setSize(
                        Math.floor(clientWidth * perfConfig.resolutionScale), 
                        Math.floor(clientHeight * perfConfig.resolutionScale)
                    );
                    state.renderer.domElement.style.width = '100%'; 
                    state.renderer.domElement.style.height = '100%';
                    container.appendChild(state.renderer.domElement); 
                    setTimeout(() => runStep(2), 20); 
                    break;
                    
                case 2:
                    state.uniforms = { 
                        u_time: { value: 0.0 }, 
                        u_resolution: { value: new THREE.Vector2(container.clientWidth, container.clientHeight) }, 
                        u_aspect: { value: container.clientWidth / container.clientHeight },
                        u_blob1_pos: { value: new THREE.Vector2(0.3, 0.7) }, 
                        u_blob2_pos: { value: new THREE.Vector2(0.6, 0.1) }, 
                        u_blob3_pos: { value: new THREE.Vector2(0.9, 0.5) }, 
                        u_column_lookup: { value: state.lookupTexture }, 
                        u_noise: { value: state.settings.noise }, 
                        u_distortion: { value: state.settings.distortion }, 
                        u_color_one: { value: new THREE.Color(container.getAttribute('data-color-one') || '#5983f8') }, 
                        u_size_one: { value: parseFloat(container.getAttribute('data-size-one')) || 0.7 }, 
                        u_color_two: { value: new THREE.Color(container.getAttribute('data-color-two') || '#c1ff5b') }, 
                        u_size_two: { value: parseFloat(container.getAttribute('data-size-two')) || 0.6 }, 
                        u_use_three_color: { value: container.getAttribute('data-use-three-color') === 'true' }, 
                        u_color_three: { value: new THREE.Color(container.getAttribute('data-color-three') || '#ffff5b') }, 
                        u_size_three: { value: parseFloat(container.getAttribute('data-size-three')) || 0.65 },
                        // Use the pre-blurred texture instead of original
                        u_background_texture: { value: state.blurredBackgroundTexture },
                        u_has_background: { value: state.blurredBackgroundTexture !== null }
                    };
                    state.material = new THREE.ShaderMaterial({ 
                        uniforms: state.uniforms, 
                        transparent: true,
                        precision: "lowp",
                        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`, 
fragmentShader: `
#ifdef GL_ES
precision lowp float;
#endif
uniform vec2 u_resolution; uniform float u_time; uniform float u_aspect; uniform vec2 u_blob1_pos; uniform vec2 u_blob2_pos; uniform vec2 u_blob3_pos; 
uniform sampler2D u_column_lookup; uniform float u_noise; uniform float u_distortion; 
uniform vec3 u_color_one; uniform float u_size_one; uniform vec3 u_color_two; uniform float u_size_two; 
uniform bool u_use_three_color; uniform vec3 u_color_three; uniform float u_size_three; 
uniform sampler2D u_background_texture; uniform bool u_has_background;
varying vec2 vUv; 

float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5); } 

vec2 random2(vec2 st) { st = vec2(dot(st,vec2(127.1,311.7)), dot(st,vec2(269.5,183.3))); return -1.0 + 2.0*fract(sin(st)*43758.5453123); }

float noise(vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(dot(random2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
                   dot(random2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
               mix(dot(random2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
                   dot(random2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
}

float fbm(vec2 st, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        if (i >= octaves) break;
        value += amplitude * noise(st);
        st *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

float noiseBlob(vec2 pos, vec2 center, float size, float time) {
    vec2 offset = pos - center;
    float dist = length(offset);
    
    float angle = atan(offset.y, offset.x);
    float edgeNoise = sin(angle * 4.0 + time * 0.8) * 0.06 + 
                      sin(angle * 7.0 - time * 0.6) * 0.03 +
                      sin(angle * 11.0 + time * 0.4) * 0.015;
    
    float organicRadius = size * (1.0 + edgeNoise);
    
    float normalizedDist = dist / organicRadius;
    if (normalizedDist >= 1.0) return 0.0;
    
    float intensity = 1.0 - (normalizedDist * normalizedDist);
    return intensity * intensity;
}

void main() { 
    vec4 d = texture2D(u_column_lookup, vec2(vUv.x, 0.0)); 
    float i = d.r * 255.0; 
    float s = sin(i * 12.99) * 43758.5; 
    float o = (fract(s) - 0.5) * u_distortion; 
    vec2 distortedUV = vec2(vUv.x + o, vUv.y); 
    
    // OPTIMIZED: Background is now pre-blurred - just a simple texture lookup!
    vec3 backgroundColor = vec3(0.0);
    if (u_has_background) {
        backgroundColor = texture2D(u_background_texture, vUv).rgb; // Already blurred!
    }
    
    vec2 aspectCorrected = vec2(distortedUV.x * u_aspect, distortedUV.y);
    vec2 blob1Corrected = vec2(u_blob1_pos.x * u_aspect, u_blob1_pos.y);
    vec2 blob2Corrected = vec2(u_blob2_pos.x * u_aspect, u_blob2_pos.y);
    vec2 blob3Corrected = vec2(u_blob3_pos.x * u_aspect, u_blob3_pos.y);
    
    float s1 = noiseBlob(aspectCorrected, blob1Corrected, u_size_one, u_time);
    float s2 = noiseBlob(aspectCorrected, blob2Corrected, u_size_two, u_time + 100.0);
    float s3 = 0.0;
    if(u_use_three_color) {
        s3 = noiseBlob(aspectCorrected, blob3Corrected, u_size_three, u_time + 200.0);
    }
    
    float intensity1 = s1;
    float intensity2 = s2; 
    float intensity3 = u_use_three_color ? s3 : 0.0;
    
    float maxIntensity = max(max(intensity1, intensity2), intensity3);
    
    if (maxIntensity <= 0.0) {
        if (u_has_background) {
            vec3 c = backgroundColor; 
            float g = (random(vUv * 0.5) - 0.5) * u_noise * 0.08; 
            c += g;
            gl_FragColor = vec4(c, 1.0);
        } else {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        }
        return;
    }
    
    vec3 blendedColor = vec3(0.0);
    float totalWeight = intensity1 + intensity2 + intensity3;
    
    if (totalWeight > 0.0) {
        blendedColor = (u_color_one * intensity1 + u_color_two * intensity2 + u_color_three * intensity3) / totalWeight;
    }
    
    vec3 finalColor;
    if (u_has_background) {
        finalColor = mix(backgroundColor, blendedColor, maxIntensity);
    } else {
        finalColor = blendedColor;
    }
    
    vec3 c = finalColor; 
    float g = (random(vUv * 0.5) - 0.5) * u_noise * 0.12; 
    c += g; 
    
    float alpha = u_has_background ? 1.0 : maxIntensity;
    gl_FragColor = vec4(c, alpha);
}`
                        });
                        state.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), state.material); 
                        state.scene.add(state.plane); 
                        setTimeout(() => runStep(3), 20); 
                        break;
                        
                    case 3:
                        const animState = { 
                            isVisible: false, 
                            lastRenderTime: 0, 
                            isHovering: false,
                            timeOffset: Math.random() * Math.PI * 2
                        }; 
                        const blobs = { b1: new THREE.Vector2(0.3, 0.7), b2: new THREE.Vector2(0.6, 0.1), b3: new THREE.Vector2(0.9, 0.5) }; 
                        const mousePos = new THREE.Vector2(0.5, 0.5);
                        const defaultTargets = { 
                            b1: new THREE.Vector2(0.3, 0.7), 
                            b2: new THREE.Vector2(0.6, 0.1), 
                            b3: new THREE.Vector2(0.9, 0.5) 
                        };
                        
                        const originalPositions = {
                            b1: new THREE.Vector2(0.3, 0.7),
                            b2: new THREE.Vector2(0.6, 0.1), 
                            b3: new THREE.Vector2(0.9, 0.5)
                        };
                        
                        const instanceController = { 
                            update: (time) => { 
                                if (renderBudgetExceeded) return;
                                if (time - animState.lastRenderTime < 33) return;
                                const timeInSeconds = (time + animState.timeOffset) * 0.0008;
                                
                                const slowTime = timeInSeconds * 0.4;
                                const mediumTime = timeInSeconds * 0.6;
                                const fastTime = timeInSeconds * 0.8;
                                
                                defaultTargets.b1.x = 0.3 + Math.sin(slowTime * 0.7) * 0.15 + Math.cos(fastTime * 0.3) * 0.08;
                                defaultTargets.b1.y = 0.7 + Math.cos(slowTime * 0.9) * 0.12 + Math.sin(mediumTime * 0.5) * 0.06;
                                
                                defaultTargets.b2.x = 0.6 + Math.cos(mediumTime * 0.8) * 0.18 + Math.sin(slowTime * 0.4) * 0.07;
                                defaultTargets.b2.y = 0.1 + Math.sin(mediumTime * 0.6) * 0.14 + Math.cos(fastTime * 0.7) * 0.05;
                                
                                defaultTargets.b3.x = 0.9 + Math.sin(fastTime * 0.5) * 0.16 + Math.cos(slowTime * 0.8) * 0.09;
                                defaultTargets.b3.y = 0.5 + Math.cos(fastTime * 0.4) * 0.13 + Math.sin(slowTime * 0.6) * 0.07;
                                
                                if (state.settings.hoverEnabled && animState.isHovering) {
                                    const offsetX = (mousePos.x - 0.5) * 2;
                                    const offsetY = (mousePos.y - 0.5) * 2;
                                    
                                    const parallax1X = offsetX * 0.08;
                                    const parallax1Y = offsetY * 0.06;
                                    
                                    const parallax2X = offsetX * -0.05;
                                    const parallax2Y = offsetY * -0.04;
                                    
                                    const parallax3X = offsetX * 0.04;
                                    const parallax3Y = offsetY * 0.03;
                                    
                                    const targetWithParallax1 = new THREE.Vector2(
                                        defaultTargets.b1.x + parallax1X,
                                        defaultTargets.b1.y + parallax1Y
                                    );
                                    
                                    const targetWithParallax2 = new THREE.Vector2(
                                        defaultTargets.b2.x + parallax2X,
                                        defaultTargets.b2.y + parallax2Y
                                    );
                                    
                                    const targetWithParallax3 = new THREE.Vector2(
                                        defaultTargets.b3.x + parallax3X,
                                        defaultTargets.b3.y + parallax3Y
                                    );
                                    
                                    blobs.b1.lerp(targetWithParallax1, 0.08);
                                    blobs.b2.lerp(targetWithParallax2, 0.06); 
                                    blobs.b3.lerp(targetWithParallax3, 0.04);
                                    
                                } else {
                                    blobs.b1.lerp(defaultTargets.b1, 0.025); 
                                    blobs.b2.lerp(defaultTargets.b2, 0.022); 
                                    blobs.b3.lerp(defaultTargets.b3, 0.018);
                                }
                                
                                state.uniforms.u_blob1_pos.value.copy(blobs.b1); 
                                state.uniforms.u_blob2_pos.value.copy(blobs.b2); 
                                state.uniforms.u_blob3_pos.value.copy(blobs.b3); 
                                state.uniforms.u_time.value = timeInSeconds;
                                const renderStart = performance.now();
                                state.renderer.render(state.scene, state.camera);
                                const renderDuration = performance.now() - renderStart;
                                animState.lastRenderTime = time;
                                if (renderDuration > 45) {
                                    console.warn(`Shader render took ${renderDuration.toFixed(1)}ms`);
                                }
                            }, 
                            setVisible: (visible) => { 
                                if (visible && !animState.isVisible) { 
                                    activeInstances.add(instanceController); 
                                } else if (!visible && animState.isVisible) { 
                                    activeInstances.delete(instanceController); 
                                } 
                                animState.isVisible = visible; 
                            } 
                        };
                        
                        const onMouseMove = e => { 
                            const rect = container.getBoundingClientRect(); 
                            mousePos.x = (e.clientX - rect.left) / rect.width; 
                            mousePos.y = 1.0 - (e.clientY - rect.top) / rect.height; 
                        };
                        
                        if (state.settings.hoverEnabled) {
                            document.addEventListener('mousemove', (e) => {
                                if (animState.isHovering) {
                                    onMouseMove(e);
                                }
                            });
                            container.addEventListener('mouseenter', () => {
                                animState.isHovering = true;
                            }); 
                            container.addEventListener('mouseleave', () => { 
                                animState.isHovering = false;
                                mousePos.set(0.5, 0.5);
                            });
                            
                            setTimeout(() => {
                                const rect = container.getBoundingClientRect();
                                const detectInitialHover = (e) => {
                                    if (e.clientX >= rect.left && e.clientX <= rect.right && 
                                        e.clientY >= rect.top && e.clientY <= rect.bottom) {
                                        animState.isHovering = true;
                                    }
                                    document.removeEventListener('mousemove', detectInitialHover);
                                };
                                document.addEventListener('mousemove', detectInitialHover);
                            }, 100);
                        }
                        
                        window.addEventListener('resize', () => { 
                            const { clientWidth, clientHeight } = container; 
                            state.renderer.setSize(clientWidth, clientHeight);
                            state.renderer.domElement.style.width = '100%'; 
                            state.renderer.domElement.style.height = '100%';
                            state.uniforms.u_resolution.value.set(clientWidth, clientHeight); 
                            state.uniforms.u_aspect.value = clientWidth / clientHeight;
                            state.camera.updateProjectionMatrix(); 
                        });
                        onComplete(instanceController); 
                        break;
                }
            } catch (e) { console.error("Shader init error:", e); onComplete(null); }
        };
        runStep(0);
    }

    const containers = document.querySelectorAll('[data-fluted-glass]');
    if (containers.length === 0) return;
    let initQueue = []; 
    let isInitializing = false;
    
    function processQueue() { 
        if (initQueue.length === 0) { isInitializing = false; return; } 
        isInitializing = true; 
        const containerToInit = initQueue.shift(); 
        initShader_StepByStep(containerToInit, (controller) => { 
            if (controller) { 
                containerToInit.shaderController = controller; 
                const rect = containerToInit.getBoundingClientRect(); 
                const isVisible = rect.top < window.innerHeight + 200 && rect.bottom >= -200;
                controller.setVisible(isVisible); 
            } 
            setTimeout(processQueue, 200);
        }); 
    }
    
    const masterObserver = new IntersectionObserver((entries) => { 
        entries.forEach(entry => { 
            const container = entry.target; 
            
            if (entry.isIntersecting && !container.shaderController) { 
                if (!initQueue.includes(container)) {
                    initQueue.push(container); 
                    if (!isInitializing) {
                        setTimeout(processQueue, 100);
                    }
                }
            } 
            
            if (container.shaderController) { 
                container.shaderController.setVisible(entry.isIntersecting); 
            } 
        }); 
    }, { rootMargin: "300px" });
    
    containers.forEach(container => masterObserver.observe(container));
}





// ALT 2 STILL SLOW 
// window.addEventListener('load', () => {
//     const performanceDelay = navigator.hardwareConcurrency < 4 ? 800 : 500;
//     setTimeout(initializeOptimizedShaders, performanceDelay);
// });

// function initializeOptimizedShaders() {
//     if (typeof THREE === 'undefined') { console.error("Shader Error: Three.js missing."); return; }
    
//     const perfConfig = { 
//         maxInstances: 8,
//         isMobile: /Mobi/i.test(navigator.userAgent),
//         resolutionScale: 0.75,
//         renderBudget: 40,
//         targetFPS: 30
//     };
    
//     let instanceCount = 0;
//     const activeInstances = new Set();
//     let lastGlobalTime = 0;
//     let frameStartTime = 0;
//     let renderBudgetExceeded = false;
    
//     function globalAnimate(currentTime) { 
//         requestAnimationFrame(globalAnimate);
//         if (currentTime - lastGlobalTime < 33) return;
//         frameStartTime = performance.now();
//         renderBudgetExceeded = false;
//         let renderedCount = 0;
//         for (const instance of activeInstances) {
//             if (renderBudgetExceeded) break;
//             const renderStart = performance.now();
//             instance.update(currentTime);
//             const renderDuration = performance.now() - renderStart;
//             renderedCount++;
//             if (performance.now() - frameStartTime > perfConfig.renderBudget) {
//                 renderBudgetExceeded = true;
//                 break;
//             }
//         }
//         lastGlobalTime = currentTime;
//     }
//     requestAnimationFrame(globalAnimate);

//     function generateColumnBoundaries(num, variation, seed) { 
//         const boundaries = [0.0]; let totalWeight = 0; const weights = []; 
//         for (let i = 0; i < num; i++) { 
//             seed = (seed * 1664525 + 1013904223) % 4294967296; const random = (seed / 4294967296); 
//             weights.push(Math.max(0.1, 1.0 + (random - 0.5) * variation)); totalWeight += weights[i]; 
//         } 
//         let pos = 0; 
//         for (let i = 0; i < weights.length - 1; i++) { pos += weights[i] / totalWeight; boundaries.push(pos); } 
//         boundaries.push(1.0); return boundaries; 
//     }
// function generateLookupTexture(boundaries, width = 512) {
//     const data = new Uint8Array(width * 4); let boundaryIndex = 0; 
//     for (let i = 0; i < width; i++) { 
//         const u = i / (width - 1); 
//         while (boundaryIndex < boundaries.length - 2 && u >= boundaries[boundaryIndex + 1]) { boundaryIndex++; } 
//         data[i * 4] = boundaryIndex; data[i * 4 + 3] = 255; 
//     } 
//     const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat); 
//     texture.needsUpdate = true; return texture; 
// }

// // NEW: Background image loading functions
// function createFallbackTexture() {
//     const size = 256;
//     const data = new Uint8Array(size * size * 3);
//     for (let i = 0; i < size; i++) {
//         for (let j = 0; j < size; j++) {
//             const idx = (i * size + j) * 3;
//             const x = i / size; const y = j / size;
//             data[idx] = Math.sin(x * Math.PI) * 255;
//             data[idx + 1] = Math.sin(y * Math.PI * 2) * 255;
//             data[idx + 2] = Math.sin((x + y) * Math.PI) * 255;
//         }
//     }
//     const texture = new THREE.DataTexture(data, size, size, THREE.RGBFormat);
//     texture.needsUpdate = true;
//     texture.wrapS = THREE.ClampToEdgeWrapping;
//     texture.wrapT = THREE.ClampToEdgeWrapping;
//     texture.minFilter = THREE.LinearFilter;
//     texture.magFilter = THREE.LinearFilter;
//     return texture;
// }

// function loadBackgroundTexture(imageUrl) {
//     return new Promise((resolve) => {
//         if (!imageUrl) { resolve(null); return; }
//         const testImg = new Image();
//         testImg.crossOrigin = 'anonymous';
//         testImg.onload = function() {
//             const loader = new THREE.TextureLoader();
//             loader.setCrossOrigin('anonymous');
//             loader.load(imageUrl, (texture) => {
//                 texture.wrapS = THREE.ClampToEdgeWrapping;
//                 texture.wrapT = THREE.ClampToEdgeWrapping;
//                 texture.minFilter = THREE.LinearFilter;
//                 texture.magFilter = THREE.LinearFilter;
//                 resolve(texture);
//             }, undefined, () => resolve(createFallbackTexture()));
//         };
//         testImg.onerror = () => resolve(createFallbackTexture());
//         testImg.src = imageUrl;
//     });
// }

// async function initShader_StepByStep(container, onComplete) {
//     const state = {};
//     const runStep = async (step) => {
//         try {
//             switch(step) {
//                 case 0:
//                     instanceCount++; 
//                     state.isLowQuality = perfConfig.isMobile || instanceCount > 2;
//                     const p = container.getAttribute('data-width-preset') || 'balanced'; 
//                     const ps = { 'balanced': { c: 5, v: 1.0, d: 0.2 }, 'extremes': { c: 4, v: 1.8, d: 0.15 }, 'minimal': { c: 3, v: 1.5, d: 0.1 }, 'dense': { c: 7, v: 0.8, d: 0.25 } }; 
//                     const c = ps[p] || ps['balanced'];
//                     state.settings = { 
//                         columns: parseInt(container.getAttribute('data-columns')) || c.c, 
//                         noise: parseFloat(container.getAttribute('data-noise')) || (state.isLowQuality ? 0.015 : 0.035),
//                         distortion: parseFloat(container.getAttribute('data-distortion')) || (c.d * 1.5), 
//                         widthVariation: parseFloat(container.getAttribute('data-width-variation')) || c.v, 
//                         sensitivityOne: parseFloat(container.getAttribute('data-sensitivity-one')) || 0.08,
//                         sensitivityTwo: parseFloat(container.getAttribute('data-sensitivity-two')) || 0.05, 
//                         sensitivityThree: parseFloat(container.getAttribute('data-sensitivity-three')) || 0.1,
//                         hoverEnabled: container.getAttribute('data-hover') !== 'false',
//                         backgroundImage: container.getAttribute('data-background-image') || null
//                     };
//                     const boundaries = generateColumnBoundaries(state.settings.columns, state.settings.widthVariation, parseInt(container.getAttribute('data-seed')) || 1234);
//                     state.lookupTexture = generateLookupTexture(boundaries); 
//                     state.backgroundTexture = await loadBackgroundTexture(state.settings.backgroundImage);
//                     setTimeout(() => runStep(1), 20);
//                     break;
                    
//                 case 1:
//                     state.scene = new THREE.Scene(); 
//                     state.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
//                     state.renderer = new THREE.WebGLRenderer({ 
//                         alpha: true, 
//                         antialias: false,
//                         powerPreference: "high-performance",
//                         precision: "lowp",
//                         stencil: false,
//                         depth: false,
//                         premultipliedAlpha: false
//                     });
//                     state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
//                     const { clientWidth, clientHeight } = container;
//                     state.renderer.setSize(
//                         Math.floor(clientWidth * perfConfig.resolutionScale), 
//                         Math.floor(clientHeight * perfConfig.resolutionScale)
//                     );
//                     state.renderer.domElement.style.width = '100%'; 
//                     state.renderer.domElement.style.height = '100%';
//                     container.appendChild(state.renderer.domElement); 
//                     setTimeout(() => runStep(2), 20); 
//                     break;
                    
//                 case 2:
//                     state.uniforms = { 
//                         u_time: { value: 0.0 }, 
//                         u_resolution: { value: new THREE.Vector2(container.clientWidth, container.clientHeight) }, 
//                         u_aspect: { value: container.clientWidth / container.clientHeight },
//                         u_blob1_pos: { value: new THREE.Vector2(0.3, 0.7) }, 
//                         u_blob2_pos: { value: new THREE.Vector2(0.6, 0.1) }, 
//                         u_blob3_pos: { value: new THREE.Vector2(0.9, 0.5) }, 
//                         u_column_lookup: { value: state.lookupTexture }, 
//                         u_noise: { value: state.settings.noise }, 
//                         u_distortion: { value: state.settings.distortion }, 
//                         u_color_one: { value: new THREE.Color(container.getAttribute('data-color-one') || '#5983f8') }, 
//                         u_size_one: { value: parseFloat(container.getAttribute('data-size-one')) || 0.7 }, 
//                         u_color_two: { value: new THREE.Color(container.getAttribute('data-color-two') || '#c1ff5b') }, 
//                         u_size_two: { value: parseFloat(container.getAttribute('data-size-two')) || 0.6 }, 
//                         u_use_three_color: { value: container.getAttribute('data-use-three-color') === 'true' }, 
//                         u_color_three: { value: new THREE.Color(container.getAttribute('data-color-three') || '#ffff5b') }, 
//                         u_size_three: { value: parseFloat(container.getAttribute('data-size-three')) || 0.65 },
//                         u_background_texture: { value: state.backgroundTexture },
//                         u_has_background: { value: state.backgroundTexture !== null }
//                     };
//                     state.material = new THREE.ShaderMaterial({ 
//                         uniforms: state.uniforms, 
//                         transparent: true,
//                         precision: "lowp",
//                         vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`, 
// fragmentShader: `
// #ifdef GL_ES
// precision lowp float;
// #endif
// uniform vec2 u_resolution; uniform float u_time; uniform float u_aspect; uniform vec2 u_blob1_pos; uniform vec2 u_blob2_pos; uniform vec2 u_blob3_pos; 
// uniform sampler2D u_column_lookup; uniform float u_noise; uniform float u_distortion; 
// uniform vec3 u_color_one; uniform float u_size_one; uniform vec3 u_color_two; uniform float u_size_two; 
// uniform bool u_use_three_color; uniform vec3 u_color_three; uniform float u_size_three; 
// uniform sampler2D u_background_texture; uniform bool u_has_background;
// varying vec2 vUv; 

// float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5); } 

// vec2 random2(vec2 st) { st = vec2(dot(st,vec2(127.1,311.7)), dot(st,vec2(269.5,183.3))); return -1.0 + 2.0*fract(sin(st)*43758.5453123); }

// float noise(vec2 st) {
//     vec2 i = floor(st);
//     vec2 f = fract(st);
//     vec2 u = f*f*(3.0-2.0*f);
//     return mix(mix(dot(random2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
//                    dot(random2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
//                mix(dot(random2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
//                    dot(random2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
// }

// float fbm(vec2 st, int octaves) {
//     float value = 0.0;
//     float amplitude = 0.5;
//     for (int i = 0; i < 4; i++) {
//         if (i >= octaves) break;
//         value += amplitude * noise(st);
//         st *= 2.0;
//         amplitude *= 0.5;
//     }
//     return value;
// }

// float noiseBlob(vec2 pos, vec2 center, float size, float time) {
//     vec2 offset = pos - center;
//     float dist = length(offset);
    
//     float angle = atan(offset.y, offset.x);
//     float edgeNoise = sin(angle * 4.0 + time * 0.8) * 0.06 + 
//                       sin(angle * 7.0 - time * 0.6) * 0.03 +
//                       sin(angle * 11.0 + time * 0.4) * 0.015;
    
//     float organicRadius = size * (1.0 + edgeNoise);
    
//     float normalizedDist = dist / organicRadius;
//     if (normalizedDist >= 1.0) return 0.0;
    
//     // Natural quadratic falloff 
//     float intensity = 1.0 - (normalizedDist * normalizedDist);
//     return intensity * intensity; // Square again for even softer edges
// }

// // Gaussian blur function
// float gaussian(vec2 i, float sigma) {
//     return exp( -0.5 * dot(i/sigma, i/sigma) ) / ( 6.28 * sigma * sigma );
// }

// vec3 gaussianBlur(sampler2D tex, vec2 uv) {
//     vec3 result = vec3(0.0);
//     float totalWeight = 0.0;
    
//     int samples = 5; 
//     float sigma = float(samples) * 0.5;
//     vec2 texelSize = 1.0 / u_resolution; // Fix: Use dynamic resolution
    
//     for (int x = -2; x <= 2; x++) {
//         for (int y = -2; y <= 2; y++) {
//             vec2 offset = vec2(float(x), float(y));
//             float weight = gaussian(offset, sigma);
//             vec2 sampleUV = uv + offset * texelSize * 2.0;
//             result += texture2D(tex, sampleUV).rgb * weight;
//             totalWeight += weight;
//         }
//     }
    
//     return result / totalWeight;
// }

// void main() { 
//     vec4 d = texture2D(u_column_lookup, vec2(vUv.x, 0.0)); 
//     float i = d.r * 255.0; 
//     float s = sin(i * 12.99) * 43758.5; 
//     float o = (fract(s) - 0.5) * u_distortion; 
//     vec2 distortedUV = vec2(vUv.x + o, vUv.y); 
    
//     // Clean background with Gaussian blur
//     vec3 backgroundColor = vec3(0.0);
//     if (u_has_background) {
//         vec2 cleanUV = vUv;
//         backgroundColor = gaussianBlur(u_background_texture, cleanUV);
//         backgroundColor *= 0.85;
//     }
    
//     vec2 aspectCorrected = vec2(distortedUV.x * u_aspect, distortedUV.y);
//     vec2 blob1Corrected = vec2(u_blob1_pos.x * u_aspect, u_blob1_pos.y);
//     vec2 blob2Corrected = vec2(u_blob2_pos.x * u_aspect, u_blob2_pos.y);
//     vec2 blob3Corrected = vec2(u_blob3_pos.x * u_aspect, u_blob3_pos.y);
    
//     float s1 = noiseBlob(aspectCorrected, blob1Corrected, u_size_one, u_time);
//     float s2 = noiseBlob(aspectCorrected, blob2Corrected, u_size_two, u_time + 100.0);
//     float s3 = 0.0;
//     if(u_use_three_color) {
//         s3 = noiseBlob(aspectCorrected, blob3Corrected, u_size_three, u_time + 200.0);
//     }
    
//     float intensity1 = s1;
//     float intensity2 = s2; 
//     float intensity3 = u_use_three_color ? s3 : 0.0;
    
//     float maxIntensity = max(max(intensity1, intensity2), intensity3);
    
//     if (maxIntensity <= 0.0) {
//         if (u_has_background) {
//             vec3 c = backgroundColor; 
//             float g = (random(vUv * 0.5) - 0.5) * u_noise * 0.08; 
//             c += g;
//             gl_FragColor = vec4(c, 1.0);
//         } else {
//             gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
//         }
//         return;
//     }
    
//     vec3 blendedColor = vec3(0.0);
//     float totalWeight = intensity1 + intensity2 + intensity3;
    
//     if (totalWeight > 0.0) {
//         blendedColor = (u_color_one * intensity1 + u_color_two * intensity2 + u_color_three * intensity3) / totalWeight;
//     }
    
//     vec3 finalColor;
//     if (u_has_background) {
//         finalColor = mix(backgroundColor, blendedColor, maxIntensity);
//     } else {
//         finalColor = blendedColor;
//     }
    
//     vec3 c = finalColor; 
//     float g = (random(vUv * 0.5) - 0.5) * u_noise * 0.12; 
//     c += g; 
    
//     float alpha = u_has_background ? 1.0 : maxIntensity;
//     gl_FragColor = vec4(c, alpha);
// }`
//                         });
//                         state.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), state.material); 
//                         state.scene.add(state.plane); 
//                         setTimeout(() => runStep(3), 20); 
//                         break;
                        
//                     case 3:
//                         const animState = { 
//                             isVisible: false, 
//                             lastRenderTime: 0, 
//                             isHovering: false,
//                             timeOffset: Math.random() * Math.PI * 2
//                         }; 
//                         const blobs = { b1: new THREE.Vector2(0.3, 0.7), b2: new THREE.Vector2(0.6, 0.1), b3: new THREE.Vector2(0.9, 0.5) }; 
//                         const mousePos = new THREE.Vector2(0.5, 0.5); // Current mouse position
//                         const defaultTargets = { 
//                             b1: new THREE.Vector2(0.3, 0.7), 
//                             b2: new THREE.Vector2(0.6, 0.1), 
//                             b3: new THREE.Vector2(0.9, 0.5) 
//                         };
                        
//                         // Store original positions for parallax calculation
//                         const originalPositions = {
//                             b1: new THREE.Vector2(0.3, 0.7),
//                             b2: new THREE.Vector2(0.6, 0.1), 
//                             b3: new THREE.Vector2(0.9, 0.5)
//                         };
                        
//                         const instanceController = { 
//                             update: (time) => { 
//                                 if (renderBudgetExceeded) return;
//                                 if (time - animState.lastRenderTime < 33) return;
//                                 const timeInSeconds = (time + animState.timeOffset) * 0.0008;
                                
//                                 // Always update default animated positions
//                                 const slowTime = timeInSeconds * 0.4;
//                                 const mediumTime = timeInSeconds * 0.6;
//                                 const fastTime = timeInSeconds * 0.8;
                                
//                                 defaultTargets.b1.x = 0.3 + Math.sin(slowTime * 0.7) * 0.15 + Math.cos(fastTime * 0.3) * 0.08;
//                                 defaultTargets.b1.y = 0.7 + Math.cos(slowTime * 0.9) * 0.12 + Math.sin(mediumTime * 0.5) * 0.06;
                                
//                                 defaultTargets.b2.x = 0.6 + Math.cos(mediumTime * 0.8) * 0.18 + Math.sin(slowTime * 0.4) * 0.07;
//                                 defaultTargets.b2.y = 0.1 + Math.sin(mediumTime * 0.6) * 0.14 + Math.cos(fastTime * 0.7) * 0.05;
                                
//                                 defaultTargets.b3.x = 0.9 + Math.sin(fastTime * 0.5) * 0.16 + Math.cos(slowTime * 0.8) * 0.09;
//                                 defaultTargets.b3.y = 0.5 + Math.cos(fastTime * 0.4) * 0.13 + Math.sin(slowTime * 0.6) * 0.07;
                                
//                                 if (state.settings.hoverEnabled && animState.isHovering) {
//                                     // 🎯 DISCRETE PARALLAX EFFECT
//                                     // Calculate offset from center (0.5, 0.5)
//                                     const offsetX = (mousePos.x - 0.5) * 2; // Range: -1 to 1
//                                     const offsetY = (mousePos.y - 0.5) * 2; // Range: -1 to 1
                                    
//                                     // Apply different parallax strengths to each blob (simulating depth layers)
//                                     // Blob 1: Closest layer (most movement)
//                                     const parallax1X = offsetX * 0.08; // More noticeable movement
//                                     const parallax1Y = offsetY * 0.06;
                                    
//                                     // Blob 2: Middle layer (medium movement)  
//                                     const parallax2X = offsetX * -0.05; // Opposite direction for depth
//                                     const parallax2Y = offsetY * -0.04;
                                    
//                                     // Blob 3: Farthest layer (least movement)
//                                     const parallax3X = offsetX * 0.04; // Same direction as blob 1 but less
//                                     const parallax3Y = offsetY * 0.03;
                                    
//                                     // Apply parallax offset to the animated positions
//                                     const targetWithParallax1 = new THREE.Vector2(
//                                         defaultTargets.b1.x + parallax1X,
//                                         defaultTargets.b1.y + parallax1Y
//                                     );
                                    
//                                     const targetWithParallax2 = new THREE.Vector2(
//                                         defaultTargets.b2.x + parallax2X,
//                                         defaultTargets.b2.y + parallax2Y
//                                     );
                                    
//                                     const targetWithParallax3 = new THREE.Vector2(
//                                         defaultTargets.b3.x + parallax3X,
//                                         defaultTargets.b3.y + parallax3Y
//                                     );
                                    
//                                     // Smoothly interpolate to parallax positions
//                                     blobs.b1.lerp(targetWithParallax1, 0.08);
//                                     blobs.b2.lerp(targetWithParallax2, 0.06); 
//                                     blobs.b3.lerp(targetWithParallax3, 0.04);
                                    
//                                 } else {
//                                     // Default animation behavior
//                                     blobs.b1.lerp(defaultTargets.b1, 0.025); 
//                                     blobs.b2.lerp(defaultTargets.b2, 0.022); 
//                                     blobs.b3.lerp(defaultTargets.b3, 0.018);
//                                 }
                                
//                                 state.uniforms.u_blob1_pos.value.copy(blobs.b1); 
//                                 state.uniforms.u_blob2_pos.value.copy(blobs.b2); 
//                                 state.uniforms.u_blob3_pos.value.copy(blobs.b3); 
//                                 state.uniforms.u_time.value = timeInSeconds;
//                                 const renderStart = performance.now();
//                                 state.renderer.render(state.scene, state.camera);
//                                 const renderDuration = performance.now() - renderStart;
//                                 animState.lastRenderTime = time;
//                                 if (renderDuration > 45) {
//                                     console.warn(`Shader render took ${renderDuration.toFixed(1)}ms`);
//                                 }
//                             }, 
//                             setVisible: (visible) => { 
//                                 if (visible && !animState.isVisible) { 
//                                     activeInstances.add(instanceController); 
//                                 } else if (!visible && animState.isVisible) { 
//                                     activeInstances.delete(instanceController); 
//                                 } 
//                                 animState.isVisible = visible; 
//                             } 
//                         };
                        
//                         const onMouseMove = e => { 
//                             const rect = container.getBoundingClientRect(); 
//                             mousePos.x = (e.clientX - rect.left) / rect.width; 
//                             mousePos.y = 1.0 - (e.clientY - rect.top) / rect.height; 
//                         };
                        
//                         if (state.settings.hoverEnabled) {
//                             document.addEventListener('mousemove', (e) => {
//                                 if (animState.isHovering) {
//                                     onMouseMove(e);
//                                 }
//                             });
//                             container.addEventListener('mouseenter', () => {
//                                 animState.isHovering = true;
//                             }); 
//                             container.addEventListener('mouseleave', () => { 
//                                 animState.isHovering = false;
//                                 mousePos.set(0.5, 0.5); // Reset to center
//                             });
                            
//                             setTimeout(() => {
//                                 const rect = container.getBoundingClientRect();
//                                 const detectInitialHover = (e) => {
//                                     if (e.clientX >= rect.left && e.clientX <= rect.right && 
//                                         e.clientY >= rect.top && e.clientY <= rect.bottom) {
//                                         animState.isHovering = true;
//                                     }
//                                     document.removeEventListener('mousemove', detectInitialHover);
//                                 };
//                                 document.addEventListener('mousemove', detectInitialHover);
//                             }, 100);
//                         }
                        
//                         window.addEventListener('resize', () => { 
//                             const { clientWidth, clientHeight } = container; 
//                             state.renderer.setSize(clientWidth, clientHeight);
//                             state.renderer.domElement.style.width = '100%'; 
//                             state.renderer.domElement.style.height = '100%';
//                             state.uniforms.u_resolution.value.set(clientWidth, clientHeight); 
//                             state.uniforms.u_aspect.value = clientWidth / clientHeight;
//                             state.camera.updateProjectionMatrix(); 
//                         });
//                         onComplete(instanceController); 
//                         break;
//                 }
//             } catch (e) { console.error("Shader init error:", e); onComplete(null); }
//         };
//         runStep(0);
//     }

//     const containers = document.querySelectorAll('[data-fluted-glass]');
//     if (containers.length === 0) return;
//     let initQueue = []; 
//     let isInitializing = false;
    
//     function processQueue() { 
//         if (initQueue.length === 0) { isInitializing = false; return; } 
//         isInitializing = true; 
//         const containerToInit = initQueue.shift(); 
//         initShader_StepByStep(containerToInit, (controller) => { 
//             if (controller) { 
//                 containerToInit.shaderController = controller; 
//                 const rect = containerToInit.getBoundingClientRect(); 
//                 const isVisible = rect.top < window.innerHeight + 200 && rect.bottom >= -200;
//                 controller.setVisible(isVisible); 
//             } 
//             setTimeout(processQueue, 200);
//         }); 
//     }
    
//     const masterObserver = new IntersectionObserver((entries) => { 
//         entries.forEach(entry => { 
//             const container = entry.target; 
            
//             if (entry.isIntersecting && !container.shaderController) { 
//                 if (!initQueue.includes(container)) {
//                     initQueue.push(container); 
//                     if (!isInitializing) {
//                         setTimeout(processQueue, 100);
//                     }
//                 }
//             } 
            
//             if (container.shaderController) { 
//                 container.shaderController.setVisible(entry.isIntersecting); 
//             } 
//         }); 
//     }, { rootMargin: "300px" });
    
//     containers.forEach(container => masterObserver.observe(container));
// }









// 


// window.addEventListener('load', () => {
//     const performanceDelay = navigator.hardwareConcurrency < 4 ? 800 : 500;
//     setTimeout(initializeOptimizedShaders, performanceDelay);
// });

// function initializeOptimizedShaders() {
//     if (typeof THREE === 'undefined') { console.error("Shader Error: Three.js missing."); return; }
    
//     const perfConfig = { 
//         maxInstances: 8,
//         isMobile: /Mobi/i.test(navigator.userAgent),
//         resolutionScale: 0.75,
//         renderBudget: 40,
//         targetFPS: 30
//     };
    
//     let instanceCount = 0;
//     const activeInstances = new Set();
//     let lastGlobalTime = 0;
//     let frameStartTime = 0;
//     let renderBudgetExceeded = false;
    
//     function globalAnimate(currentTime) { 
//         requestAnimationFrame(globalAnimate);
//         if (currentTime - lastGlobalTime < 33) return;
//         frameStartTime = performance.now();
//         renderBudgetExceeded = false;
//         let renderedCount = 0;
//         for (const instance of activeInstances) {
//             if (renderBudgetExceeded) break;
//             const renderStart = performance.now();
//             instance.update(currentTime);
//             const renderDuration = performance.now() - renderStart;
//             renderedCount++;
//             if (performance.now() - frameStartTime > perfConfig.renderBudget) {
//                 renderBudgetExceeded = true;
//                 break;
//             }
//         }
//         lastGlobalTime = currentTime;
//     }
//     requestAnimationFrame(globalAnimate);

//     function generateColumnBoundaries(num, variation, seed) { 
//         const boundaries = [0.0]; let totalWeight = 0; const weights = []; 
//         for (let i = 0; i < num; i++) { 
//             seed = (seed * 1664525 + 1013904223) % 4294967296; const random = (seed / 4294967296); 
//             weights.push(Math.max(0.1, 1.0 + (random - 0.5) * variation)); totalWeight += weights[i]; 
//         } 
//         let pos = 0; 
//         for (let i = 0; i < weights.length - 1; i++) { pos += weights[i] / totalWeight; boundaries.push(pos); } 
//         boundaries.push(1.0); return boundaries; 
//     }
    
//     function generateLookupTexture(boundaries, width = 512) {
//         const data = new Uint8Array(width * 4); let boundaryIndex = 0; 
//         for (let i = 0; i < width; i++) { 
//             const u = i / (width - 1); 
//             while (boundaryIndex < boundaries.length - 2 && u >= boundaries[boundaryIndex + 1]) { boundaryIndex++; } 
//             data[i * 4] = boundaryIndex; data[i * 4 + 3] = 255; 
//         } 
//         const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat); 
//         texture.needsUpdate = true; return texture; 
//     }

//     function initShader_StepByStep(container, onComplete) {
//         const state = {};
//         const runStep = (step) => {
//             try {
//                 switch(step) {
//                     case 0:
//                         instanceCount++; 
//                         state.isLowQuality = perfConfig.isMobile || instanceCount > 2;
//                         const p = container.getAttribute('data-width-preset') || 'balanced'; 
//                         const ps = { 'balanced': { c: 5, v: 1.0, d: 0.2 }, 'extremes': { c: 4, v: 1.8, d: 0.15 }, 'minimal': { c: 3, v: 1.5, d: 0.1 }, 'dense': { c: 7, v: 0.8, d: 0.25 } }; 
//                         const c = ps[p] || ps['balanced'];
//                         state.settings = { 
//                             columns: parseInt(container.getAttribute('data-columns')) || c.c, 
//                             noise: parseFloat(container.getAttribute('data-noise')) || (state.isLowQuality ? 0.015 : 0.035),
//                             distortion: parseFloat(container.getAttribute('data-distortion')) || c.d, 
//                             widthVariation: parseFloat(container.getAttribute('data-width-variation')) || c.v, 
//                             sensitivityOne: parseFloat(container.getAttribute('data-sensitivity-one')) || 0.08,
//                             sensitivityTwo: parseFloat(container.getAttribute('data-sensitivity-two')) || 0.05, 
//                             sensitivityThree: parseFloat(container.getAttribute('data-sensitivity-three')) || 0.1,
//                             hoverEnabled: container.getAttribute('data-hover') !== 'false'
//                         };
//                         const boundaries = generateColumnBoundaries(state.settings.columns, state.settings.widthVariation, parseInt(container.getAttribute('data-seed')) || 1234);
//                         state.lookupTexture = generateLookupTexture(boundaries); 
//                         setTimeout(() => runStep(1), 20);
//                         break;
                        
//                     case 1:
//                         state.scene = new THREE.Scene(); 
//                         state.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
//                         state.renderer = new THREE.WebGLRenderer({ 
//                             alpha: true, 
//                             antialias: false,
//                             powerPreference: "high-performance",
//                             precision: "lowp",
//                             stencil: false,
//                             depth: false,
//                             premultipliedAlpha: false
//                         });
//                         state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
//                         const { clientWidth, clientHeight } = container;
//                         state.renderer.setSize(
//                             Math.floor(clientWidth * perfConfig.resolutionScale), 
//                             Math.floor(clientHeight * perfConfig.resolutionScale)
//                         );
//                         state.renderer.domElement.style.width = '100%'; 
//                         state.renderer.domElement.style.height = '100%';
//                         container.appendChild(state.renderer.domElement); 
//                         setTimeout(() => runStep(2), 20); 
//                         break;
                        
//                     case 2:
//                         state.uniforms = { 
//                             u_time: { value: 0.0 }, 
//                             u_resolution: { value: new THREE.Vector2(container.clientWidth, container.clientHeight) }, 
//                             u_aspect: { value: container.clientWidth / container.clientHeight },
//                             u_blob1_pos: { value: new THREE.Vector2(0.3, 0.7) }, 
//                             u_blob2_pos: { value: new THREE.Vector2(0.6, 0.1) }, 
//                             u_blob3_pos: { value: new THREE.Vector2(0.9, 0.5) }, 
//                             u_column_lookup: { value: state.lookupTexture }, 
//                             u_noise: { value: state.settings.noise }, 
//                             u_distortion: { value: state.settings.distortion }, 
//                             u_color_one: { value: new THREE.Color(container.getAttribute('data-color-one') || '#5983f8') }, 
//                             u_size_one: { value: parseFloat(container.getAttribute('data-size-one')) || 0.7 }, 
//                             u_color_two: { value: new THREE.Color(container.getAttribute('data-color-two') || '#c1ff5b') }, 
//                             u_size_two: { value: parseFloat(container.getAttribute('data-size-two')) || 0.6 }, 
//                             u_use_three_color: { value: container.getAttribute('data-use-three-color') === 'true' }, 
//                             u_color_three: { value: new THREE.Color(container.getAttribute('data-color-three') || '#ffff5b') }, 
//                             u_size_three: { value: parseFloat(container.getAttribute('data-size-three')) || 0.65 }, 
//                         };
//                         state.material = new THREE.ShaderMaterial({ 
//                             uniforms: state.uniforms, 
//                             transparent: true,
//                             precision: "lowp",
//                             vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`, 
// fragmentShader: `
// #ifdef GL_ES
// precision lowp float;
// #endif
// uniform vec2 u_resolution; uniform float u_time; uniform float u_aspect; uniform vec2 u_blob1_pos; uniform vec2 u_blob2_pos; uniform vec2 u_blob3_pos; 
// uniform sampler2D u_column_lookup; uniform float u_noise; uniform float u_distortion; 
// uniform vec3 u_color_one; uniform float u_size_one; uniform vec3 u_color_two; uniform float u_size_two; 
// uniform bool u_use_three_color; uniform vec3 u_color_three; uniform float u_size_three; 
// varying vec2 vUv; 

// float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5); } 

// vec2 random2(vec2 st) { st = vec2(dot(st,vec2(127.1,311.7)), dot(st,vec2(269.5,183.3))); return -1.0 + 2.0*fract(sin(st)*43758.5453123); }

// float noise(vec2 st) {
//     vec2 i = floor(st);
//     vec2 f = fract(st);
//     vec2 u = f*f*(3.0-2.0*f);
//     return mix(mix(dot(random2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
//                    dot(random2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
//                mix(dot(random2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
//                    dot(random2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
// }

// float fbm(vec2 st, int octaves) {
//     float value = 0.0;
//     float amplitude = 0.5;
//     for (int i = 0; i < 4; i++) {
//         if (i >= octaves) break;
//         value += amplitude * noise(st);
//         st *= 2.0;
//         amplitude *= 0.5;
//     }
//     return value;
// }

// float noiseBlob(vec2 pos, vec2 center, float size, float time) {
//     vec2 offset = pos - center;
//     float dist = length(offset);
    
//     float angle = atan(offset.y, offset.x);
//     float edgeNoise = sin(angle * 4.0 + time * 0.8) * 0.06 + 
//                       sin(angle * 7.0 - time * 0.6) * 0.03 +
//                       sin(angle * 11.0 + time * 0.4) * 0.015;
    
//     float organicRadius = size * (1.0 + edgeNoise);
    
//     // COMPLETELY DIFFERENT APPROACH: Use inverse square for natural falloff
//     float normalizedDist = dist / organicRadius;
//     if (normalizedDist >= 1.0) return 0.0;
    
//     // Natural quadratic falloff - no harsh transitions
//     float intensity = 1.0 - (normalizedDist * normalizedDist);
//     return intensity * intensity; // Square again for even softer edges
// }

// void main() { 
//     vec4 d = texture2D(u_column_lookup, vec2(vUv.x, 0.0)); 
//     float i = d.r * 255.0; 
//     float s = sin(i * 12.99) * 43758.5; 
//     float o = (fract(s) - 0.5) * u_distortion; 
//     vec2 u = vec2(vUv.x + o, vUv.y); 
    
//     vec2 aspectCorrected = vec2(u.x * u_aspect, u.y);
//     vec2 blob1Corrected = vec2(u_blob1_pos.x * u_aspect, u_blob1_pos.y);
//     vec2 blob2Corrected = vec2(u_blob2_pos.x * u_aspect, u_blob2_pos.y);
//     vec2 blob3Corrected = vec2(u_blob3_pos.x * u_aspect, u_blob3_pos.y);
    
//     float s1 = noiseBlob(aspectCorrected, blob1Corrected, u_size_one, u_time);
//     float s2 = noiseBlob(aspectCorrected, blob2Corrected, u_size_two, u_time + 100.0);
//     float s3 = 0.0;
//     if(u_use_three_color) {
//         s3 = noiseBlob(aspectCorrected, blob3Corrected, u_size_three, u_time + 200.0);
//     }
    
//     // 🎯 RADICAL FIX: Premultiplied alpha approach
//     // Calculate intensity for each blob
//     float intensity1 = s1;
//     float intensity2 = s2; 
//     float intensity3 = u_use_three_color ? s3 : 0.0;
    
//     // Find the strongest blob at this pixel
//     float maxIntensity = max(max(intensity1, intensity2), intensity3);
    
//     // If no blob influence, output transparent
//     if (maxIntensity <= 0.0) {
//         gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
//         return;
//     }
    
//     // Blend colors based on their relative strengths
//     vec3 blendedColor = vec3(0.0);
//     float totalWeight = intensity1 + intensity2 + intensity3;
    
//     if (totalWeight > 0.0) {
//         blendedColor = (u_color_one * intensity1 + u_color_two * intensity2 + u_color_three * intensity3) / totalWeight;
//     }
    
//     // Use the maximum intensity as alpha - this prevents dark edges
//     vec3 finalColor = blendedColor;
    
//     vec3 c = finalColor; 
//     float g = (random(vUv * 0.5) - 0.5) * u_noise * 0.12; 
//     c += g; 
    
//     gl_FragColor = vec4(c, maxIntensity);
// }`
//                         });
//                         state.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), state.material); 
//                         state.scene.add(state.plane); 
//                         setTimeout(() => runStep(3), 20); 
//                         break;
                        
//                     case 3:
//                         const animState = { 
//                             isVisible: false, 
//                             lastRenderTime: 0, 
//                             isHovering: false,
//                             timeOffset: Math.random() * Math.PI * 2
//                         }; 
//                         const blobs = { b1: new THREE.Vector2(0.3, 0.7), b2: new THREE.Vector2(0.6, 0.1), b3: new THREE.Vector2(0.9, 0.5) }; 
//                         const mouseTarget = new THREE.Vector2(0.5, 0.5);
//                         const defaultTargets = { 
//                             b1: new THREE.Vector2(0.3, 0.7), 
//                             b2: new THREE.Vector2(0.6, 0.1), 
//                             b3: new THREE.Vector2(0.9, 0.5) 
//                         };
//                         const instanceController = { 
//                             update: (time) => { 
//                                 if (renderBudgetExceeded) return;
//                                 if (time - animState.lastRenderTime < 33) return;
//                                 const timeInSeconds = (time + animState.timeOffset) * 0.0008;
                                
//                                 if (state.settings.hoverEnabled && animState.isHovering) {
//                                     blobs.b1.lerp(mouseTarget, state.settings.sensitivityOne); 
//                                     blobs.b2.lerp(new THREE.Vector2(1.0 - mouseTarget.x, 1.0 - mouseTarget.y), state.settings.sensitivityTwo); 
//                                     blobs.b3.lerp(new THREE.Vector2(mouseTarget.x, 1.0 - mouseTarget.y), state.settings.sensitivityThree);
//                                 } else {
//                                     const slowTime = timeInSeconds * 0.4;
//                                     const mediumTime = timeInSeconds * 0.6;
//                                     const fastTime = timeInSeconds * 0.8;
                                    
//                                     defaultTargets.b1.x = 0.3 + Math.sin(slowTime * 0.7) * 0.15 + Math.cos(fastTime * 0.3) * 0.08;
//                                     defaultTargets.b1.y = 0.7 + Math.cos(slowTime * 0.9) * 0.12 + Math.sin(mediumTime * 0.5) * 0.06;
                                    
//                                     defaultTargets.b2.x = 0.6 + Math.cos(mediumTime * 0.8) * 0.18 + Math.sin(slowTime * 0.4) * 0.07;
//                                     defaultTargets.b2.y = 0.1 + Math.sin(mediumTime * 0.6) * 0.14 + Math.cos(fastTime * 0.7) * 0.05;
                                    
//                                     defaultTargets.b3.x = 0.9 + Math.sin(fastTime * 0.5) * 0.16 + Math.cos(slowTime * 0.8) * 0.09;
//                                     defaultTargets.b3.y = 0.5 + Math.cos(fastTime * 0.4) * 0.13 + Math.sin(slowTime * 0.6) * 0.07;
                                    
//                                     blobs.b1.lerp(defaultTargets.b1, 0.025); 
//                                     blobs.b2.lerp(defaultTargets.b2, 0.022); 
//                                     blobs.b3.lerp(defaultTargets.b3, 0.018);
//                                 }
//                                 state.uniforms.u_blob1_pos.value.copy(blobs.b1); 
//                                 state.uniforms.u_blob2_pos.value.copy(blobs.b2); 
//                                 state.uniforms.u_blob3_pos.value.copy(blobs.b3); 
//                                 state.uniforms.u_time.value = timeInSeconds;
//                                 const renderStart = performance.now();
//                                 state.renderer.render(state.scene, state.camera);
//                                 const renderDuration = performance.now() - renderStart;
//                                 animState.lastRenderTime = time;
//                                 if (renderDuration > 45) {
//                                     console.warn(`Shader render took ${renderDuration.toFixed(1)}ms`);
//                                 }
//                             }, 
//                             setVisible: (visible) => { 
//                                 if (visible && !animState.isVisible) { 
//                                     activeInstances.add(instanceController); 
//                                 } else if (!visible && animState.isVisible) { 
//                                     activeInstances.delete(instanceController); 
//                                 } 
//                                 animState.isVisible = visible; 
//                             } 
//                         };
//                         const onMouseMove = e => { 
//                             const rect = container.getBoundingClientRect(); 
//                             mouseTarget.x = (e.clientX - rect.left) / rect.width; 
//                             mouseTarget.y = 1.0 - (e.clientY - rect.top) / rect.height; 
//                         };
                        
//                         if (state.settings.hoverEnabled) {
//                             document.addEventListener('mousemove', (e) => {
//                                 if (animState.isHovering) {
//                                     onMouseMove(e);
//                                 }
//                             });
//                             container.addEventListener('mouseenter', () => {
//                                 animState.isHovering = true;
//                             }); 
//                             container.addEventListener('mouseleave', () => { 
//                                 animState.isHovering = false;
//                                 mouseTarget.set(0.5, 0.5); 
//                             });
                            
//                             setTimeout(() => {
//                                 const rect = container.getBoundingClientRect();
//                                 const detectInitialHover = (e) => {
//                                     if (e.clientX >= rect.left && e.clientX <= rect.right && 
//                                         e.clientY >= rect.top && e.clientY <= rect.bottom) {
//                                         animState.isHovering = true;
//                                     }
//                                     document.removeEventListener('mousemove', detectInitialHover);
//                                 };
//                                 document.addEventListener('mousemove', detectInitialHover);
//                             }, 100);
//                         }
                        
//                         window.addEventListener('resize', () => { 
//                             const { clientWidth, clientHeight } = container; 
//                             state.renderer.setSize(clientWidth, clientHeight);
//                             state.renderer.domElement.style.width = '100%'; 
//                             state.renderer.domElement.style.height = '100%';
//                             state.uniforms.u_resolution.value.set(clientWidth, clientHeight); 
//                             state.uniforms.u_aspect.value = clientWidth / clientHeight;
//                             state.camera.updateProjectionMatrix(); 
//                         });
//                         onComplete(instanceController); 
//                         break;
//                 }
//             } catch (e) { console.error("Shader init error:", e); onComplete(null); }
//         };
//         runStep(0);
//     }

//     const containers = document.querySelectorAll('[data-fluted-glass]');
//     if (containers.length === 0) return;
//     let initQueue = []; 
//     let isInitializing = false;
    
//     function processQueue() { 
//         if (initQueue.length === 0) { isInitializing = false; return; } 
//         isInitializing = true; 
//         const containerToInit = initQueue.shift(); 
//         initShader_StepByStep(containerToInit, (controller) => { 
//             if (controller) { 
//                 containerToInit.shaderController = controller; 
//                 const rect = containerToInit.getBoundingClientRect(); 
//                 const isVisible = rect.top < window.innerHeight + 200 && rect.bottom >= -200;
//                 controller.setVisible(isVisible); 
//             } 
//             setTimeout(processQueue, 200);
//         }); 
//     }
    
//     const masterObserver = new IntersectionObserver((entries) => { 
//         entries.forEach(entry => { 
//             const container = entry.target; 
            
//             if (entry.isIntersecting && !container.shaderController) { 
//                 if (!initQueue.includes(container)) {
//                     initQueue.push(container); 
//                     if (!isInitializing) {
//                         setTimeout(processQueue, 100);
//                     }
//                 }
//             } 
            
//             if (container.shaderController) { 
//                 container.shaderController.setVisible(entry.isIntersecting); 
//             } 
//         }); 
//     }, { rootMargin: "300px" });
    
//     containers.forEach(container => masterObserver.observe(container));
// }

/* A local 2D cutout rig: separate ears + two-joint arms, continuously retargeted.
 * No Cubism runtime, model service, third-party requests or settings writes.
 * Coordinates use the 1024 × 1536 body drawing. Atlas rectangles only sample the
 * generated texture; the original PNG assets are retained unchanged.
 */
window.createCompanionRig = function ({ host, stage, fallback, onReaction, assetBase = '/console-assets', assetExtension = 'png' }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'companion-canvas'; canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true; host.prepend(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const parts = {
    upperLeft: { rect: [164, 22, 284, 413], root: [330, 115], tip: [300, 405] },
    upperRight: { rect: [614, 22, 287, 413], root: [725, 115], tip: [755, 405] },
    lowerLeft: { rect: [178, 557, 233, 282], root: [292, 605], tip: [292, 832] },
    lowerRight: { rect: [645, 557, 234, 282], root: [756, 605], tip: [756, 832] },
    handLeft: { rect: [178, 818, 233, 178], root: [292, 832], tip: [292, 927] },
    handRight: { rect: [645, 818, 234, 178], root: [756, 832], tip: [756, 927] },
    earLeft: { rect: [1052, 182, 439, 273], root: [1434, 255], tip: [1070, 255] },
    earRight: { rect: [1060, 670, 449, 274], root: [1124, 752], tip: [1490, 752] },
  };
  const gestures = {
    wave: { duration: 2.8, line: '嗨，今天也请多关照。' },
    cover: { duration: 2.2, line: '欸——不许偷看。' },
    ears: { duration: 2.2, line: '听见啦，耳朵动一动。' },
    pat: { duration: 3.2, line: '只许轻轻摸一下哦。' },
    speak: { duration: 3.0, line: '嗯，我在呢。慢慢说。' },
    heart: { duration: 3.0, line: '才、才没有很开心呢。' },
    think: { duration: 3.2, line: '让我想想……我记得的。' },
    cheer: { duration: 2.6, line: '好耶，今天也很顺利！' },
    yawn: { duration: 3.5, line: '呼……稍微休息一下。' },
  };
  const values = { ...Object.fromEntries(Object.keys(gestures).map(key => [key, 0])), lookX: 0, lookY: 0 };
  const velocity = Object.fromEntries(Object.keys(values).map(key => [key, 0]));
  const radians = degrees => degrees * Math.PI / 180;
  // Angles are mirrored around the torso, measured from a hanging upper arm.
  // Signed elbow angles describe the frontal projection of an inward/outward
  // arm plane; their magnitude is always limited to normal elbow flexion.
  const jointLimits = { shoulder: [-25, 165], elbow: [-145, 145], wrist: [-25, 25] };
  const armLengths = { upper: 140, forearm: 135, hand: 56.5 };
  const neutralArm = [8, 10, -5];
  const lastJoints = {};
  let ready = false, visible = false, inViewport = true, paused = false, greeted = false;
  let frame = 0, previousTime = 0, elapsed = 0, lastPaint = 0, hoverAction = '', playAction = '', playUntil = 0;
  let pointer = { x: 0, y: 0 }, body, atlas, expression, destroyed = false;
  let nextBlink = 3.6, blinkStart = -10;
  let currentPose = 'idle';
  stage.dataset.rigReady = 'loading'; stage.dataset.pose = 'idle';

  function texture(name, root, tip, scaleMultiplier = 1) {
    const part = parts[name];
    const [sx, sy, sw, sh] = part.rect;
    const sourceAngle = Math.atan2(part.tip[1] - part.root[1], part.tip[0] - part.root[0]);
    const angle = Math.atan2(tip.y - root.y, tip.x - root.x) - sourceAngle;
    const length = Math.hypot(tip.x - root.x, tip.y - root.y);
    const sourceLength = Math.hypot(part.tip[0] - part.root[0], part.tip[1] - part.root[1]);
    const scale = length / sourceLength * scaleMultiplier;
    ctx.save(); ctx.translate(root.x, root.y); ctx.rotate(angle); ctx.scale(scale, scale);
    ctx.drawImage(atlas, sx, sy, sw, sh, sx - part.root[0], sy - part.root[1], sw, sh);
    ctx.restore();
  }
  function arm(side, angles) {
    const left = side === 'Left';
    const root = { x: left ? 352 : 674, y: 795 };
    const shoulder = clamp(angles[0], ...jointLimits.shoulder);
    const flexion = clamp(angles[1], ...jointLimits.elbow);
    const wristAngle = clamp(angles[2], ...jointLimits.wrist);
    const direction = left ? -1 : 1;
    const endpoint = (origin, length, degrees) => ({
      x: origin.x + direction * Math.sin(radians(degrees)) * length,
      y: origin.y + Math.cos(radians(degrees)) * length,
    });
    const elbow = endpoint(root, armLengths.upper, shoulder);
    const wrist = endpoint(elbow, armLengths.forearm, shoulder + flexion);
    const palm = endpoint(wrist, armLengths.hand, shoulder + flexion + wristAngle);
    texture('upper' + side, root, elbow);
    texture('lower' + side, elbow, wrist);
    texture('hand' + side, wrist, palm);
    lastJoints[side] = { shoulder, flexion, wristAngle, root, elbow, wrist, palm };
  }
  function ear(left, amount, seconds) {
    const root = { x: left ? 210 : 813, y: 423 };
    const rest = left ? Math.PI - .30 : .30;
    const flutter = Math.sin(seconds * 20 + (left ? 0 : .8)) * .25 * amount;
    const relaxed = values.pat * .15 + values.heart * .08;
    const angle = rest + flutter + (left ? -1 : 1) * relaxed + Math.sin(seconds * 1.6) * .018;
    const length = 178;
    texture(left ? 'earLeft' : 'earRight', root, { x: root.x + Math.cos(angle) * length, y: root.y + Math.sin(angle) * length });
  }
  function paint(seconds) {
    if (!ready || destroyed) return;
    const scale = canvas.width / 1024;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const breath = paused ? 0 : Math.sin(seconds * 2.05) * 3;
    // A small lean accompanies the gesture; hands and ears remain separate joints.
    // Keep the painted legs and feet planted. Only the torso leans/breathes;
    // a small overlap under the skirt hides the waist boundary.
    ctx.drawImage(body, 0, 1260, 1024, 276, 0, 1260, 1024, 276);
    ctx.save();
    ctx.translate(512 + values.lookX * 5, 1275 + breath + values.lookY * 2);
    ctx.rotate(values.lookX * .01 - values.cover * .015 + values.wave * .012
      - values.pat * .025 + values.think * .02 - values.heart * .015 + values.yawn * .015);
    ctx.scale(1, 1 + (paused ? 0 : Math.sin(seconds * 2.05) * .002));
    ctx.translate(-512, -1275);
    ctx.drawImage(body, 0, 0, 1024, 1285, 0, 0, 1024, 1285);
    // Expressions are independent texture regions; the rest of the drawing never swaps frames.
    if (expression) {
      const phase = seconds - blinkStart;
      const blink = !paused && phase >= 0 && phase < .22 ? Math.sin(phase / .22 * Math.PI) : 0;
      const closed = clamp(Math.max(blink, values.pat, values.cheer, values.yawn, values.heart), 0, 1);
      ctx.save(); ctx.globalAlpha = closed;
      ctx.drawImage(expression, 311, 486, 379, 134, 311, 486, 379, 134);
      const talking = values.speak * (.5 + .5 * Math.sin(seconds * 10));
      ctx.globalAlpha = clamp(Math.max(talking, values.wave, values.cheer, values.yawn, values.pat, values.heart), 0, 1);
      ctx.drawImage(expression, 474, 605, 65, 55, 474, 605, 65, 55);
      ctx.restore();
    }
    const blush = Math.max(values.pat, values.heart) * .16;
    if (blush > .005) {
      for (const x of [365, 640]) {
        const color = ctx.createRadialGradient(x, 622, 0, x, 622, 47);
        color.addColorStop(0, `rgba(236,112,139,${blush})`); color.addColorStop(1, 'rgba(236,112,139,0)');
        ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, 622, 47, 30, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    const earMotion = Math.max(values.ears, values.cheer * .45);
    ear(true, earMotion, seconds); ear(false, earMotion, seconds);
    const waveCycle = Math.sin(seconds * 6);
    const targets = {
      wave: [neutralArm, [116, 68, waveCycle * 14]],
      cover: [[148, 80, -5], [148, 80, -5]],
      pat: [neutralArm, [115, 107, -8]],
      speak: [neutralArm, [15, 140 + Math.sin(seconds * 3) * 3, -10]],
      heart: [[25, -130, 8], [25, -130, 8]],
      think: [neutralArm, [98, 145, -8]],
      cheer: [[125, 48, -6], [125, 48, -6]],
      yawn: [[158, 105, 0], neutralArm],
    };
    for (const [index, side] of [[0, 'Left'], [1, 'Right']]) {
      const angles = [...neutralArm];
      for (const [key, target] of Object.entries(targets)) {
        for (let joint = 0; joint < 3; joint++) angles[joint] += values[key] * (target[index][joint] - neutralArm[joint]);
      }
      arm(side, angles);
    }
    ctx.restore();
  }
  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width) return;
    const width = Math.max(1, Math.round(rect.width * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width !== width || canvas.height !== Math.round(width * 1.5)) {
      canvas.width = width; canvas.height = Math.round(width * 1.5);
      paint(elapsed);
    }
  }
  function setPose(pose) {
    if (pose === currentPose) return;
    currentPose = pose; stage.dataset.pose = pose;
    onReaction?.(gestures[pose]?.line || '', pose);
  }
  function activePose() {
    if (paused) return 'idle';
    if (hoverAction) return hoverAction;
    if (playAction && elapsed < playUntil) return playAction;
    playAction = ''; return 'idle';
  }
  function tick(now) {
    frame = 0;
    if (!ready || !visible || !inViewport || paused || document.hidden || destroyed) { previousTime = 0; return; }
    const dt = Math.min((now - (previousTime || now - 16.67)) / 1000, .033);
    previousTime = now; elapsed += dt;
    if (elapsed >= nextBlink) { blinkStart = elapsed; nextBlink = elapsed + 3.8 + Math.sin(elapsed * .8) * .9; }
    const pose = activePose(); setPose(pose);
    const target = { ...Object.fromEntries(Object.keys(gestures).map(key => [key, +(pose === key)])), lookX: pointer.x, lookY: pointer.y };
    // Critically damped springs retain their current velocity when interrupted.
    for (const key of Object.keys(values)) {
      const stiffness = key.startsWith('look') ? 65 : 125;
      const damping = 2 * Math.sqrt(stiffness);
      velocity[key] += (stiffness * (target[key] - values[key]) - damping * velocity[key]) * dt;
      values[key] += velocity[key] * dt;
    }
    // Idle is painted at 30 Hz; interactions track the display refresh rate.
    const moving = pose !== 'idle' || Object.keys(gestures).some(key => Math.abs(values[key]) > .01) || elapsed - blinkStart < .25;
    if (moving || now - lastPaint >= 32) { paint(elapsed); lastPaint = now; }
    frame = requestAnimationFrame(tick);
  }
  function resume() {
    if (!ready || !visible || !inViewport || paused || document.hidden || destroyed || frame) return;
    if (!greeted) { greeted = true; playAction = 'wave'; playUntil = elapsed + 2.8; }
    frame = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver(entries => {
    inViewport = entries[0]?.isIntersecting === true;
    if (inViewport) resume(); else stop();
  }, { threshold: .15 }); intersectionObserver.observe(stage);
  const visibilityChanged = () => { if (document.hidden) stop(); else resume(); };
  document.addEventListener('visibilitychange', visibilityChanged);
  const load = src => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Character texture unavailable')); image.src = src;
  });
  const asset = name => `${assetBase}/${name}.${assetExtension}`;
  Promise.all([load(asset('mascot-body')), load(asset('mascot-parts')), load(asset('mascot-expression')).catch(() => null)]).then(images => {
    if (destroyed) return;
    [body, atlas, expression] = images; ready = true; resize(); paint(0);
    stage.dataset.expressionsReady = expression ? 'ready' : 'unavailable';
    fallback.hidden = true; canvas.hidden = false; stage.dataset.rigReady = 'ready';
    resume();
  }).catch(() => { stage.dataset.rigReady = 'fallback'; canvas.hidden = true; fallback.hidden = false; });
  return {
    capture(seconds, pose = 'wave', amount = 1) {
      stop(); paused = true;
      for (const key of Object.keys(values)) { values[key] = 0; velocity[key] = 0; }
      if (pose in gestures) values[pose] = clamp(amount, 0, 1);
      paint(seconds);
    },
    inspectPose() { return { lengths: { ...armLengths }, limits: jointLimits, joints: structuredClone(lastJoints) }; },
    hover(action) { if (paused || (action && !gestures[action])) return; hoverAction = action; playAction = ''; resume(); },
    play(action) { if (paused || !ready || !gestures[action]) return; hoverAction = ''; playAction = action; playUntil = elapsed + gestures[action].duration; resume(); },
    look(x, y) { pointer = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }; resume(); },
    setVisible(value) { visible = value; if (value) { resize(); resume(); } else { hoverAction = ''; playAction = ''; pointer = { x: 0, y: 0 }; stop(); } },
    setPaused(value) {
      paused = value;
      if (paused) {
        stop(); hoverAction = ''; playAction = '';
        for (const key of Object.keys(values)) { values[key] = 0; velocity[key] = 0; }
        setPose('idle'); paint(0);
      } else resume();
    },
    destroy() { destroyed = true; stop(); resizeObserver.disconnect(); intersectionObserver.disconnect(); document.removeEventListener('visibilitychange', visibilityChanged); },
  };
};

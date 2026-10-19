(() => {
  'use strict';

  // A connected, original 21 × 23 maze. S is the courier's starting tile.
  const MAZE = [
    '#####################',
    '#o.......#.#.......o#',
    '#.##.###.#.#.###.##.#',
    '#....#...#.#...#....#',
    '###.##.#.....#.##.###',
    '#...#..#.###.#..#...#',
    '#.#.#.##.#.#.##.#.#.#',
    '#.#......#.#......#.#',
    '#.###.##.....##.###.#',
    '#.....#..#.#..#.....#',
    '#.###.#.#...#.#.###.#',
    '#...#...#...#...#...#',
    '###.#.#.#####.#.#.###',
    '#.....#...#...#.....#',
    '#.###.###.#.###.###.#',
    '#.#.......S.......#.#',
    '#.#.##.#######.##.#.#',
    '#...#.....#.....#...#',
    '###.#.###.#.###.#.###',
    '#...#...#...#...#...#',
    '#.#####.#.#.#.#####.#',
    '#o......#.#.#......o#',
    '#####################',
  ];
  const TILE = 30;
  const COLS = MAZE[0].length;
  const ROWS = MAZE.length;
  const WIDTH = COLS * TILE;
  const HEIGHT = ROWS * TILE;
  const STEP = 1 / 120;
  const START = { col: 10, row: 15 };
  const DIRECTIONS = {
    up: { x: 0, y: -1, angle: -Math.PI / 2, opposite: 'down' },
    left: { x: -1, y: 0, angle: Math.PI, opposite: 'right' },
    down: { x: 0, y: 1, angle: Math.PI / 2, opposite: 'up' },
    right: { x: 1, y: 0, angle: 0, opposite: 'left' },
  };
  const GUARDS = [
    { col: 9, row: 10, color: '#f38d87', personality: 'chase', corner: { col: 19, row: 1 } },
    { col: 11, row: 10, color: '#b8a1ee', personality: 'ambush', corner: { col: 1, row: 1 } },
    { col: 10, row: 9, color: '#79c9d8', personality: 'flank', corner: { col: 19, row: 21 } },
    { col: 10, row: 11, color: '#edb786', personality: 'wander', corner: { col: 1, row: 21 } },
  ];
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayText = document.getElementById('overlayText');
  const overlayEyebrow = document.getElementById('overlayEyebrow');
  const overlayHint = document.getElementById('overlayHint');
  const startButton = document.getElementById('startButton');
  const pauseButton = document.getElementById('pauseButton');
  const statusText = document.getElementById('statusText');
  const scoreValue = document.getElementById('scoreValue');
  const bestValue = document.getElementById('bestValue');
  const levelValue = document.getElementById('levelValue');
  const livesValue = document.getElementById('livesValue');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bestKey = 'iskra.best.v1';
  let best = 0;
  try {
    const stored = Number(localStorage.getItem(bestKey));
    if (Number.isFinite(stored) && stored > 0) best = Math.floor(stored);
  } catch { /* The game also works when local storage is unavailable. */ }

  let state = 'ready';
  let score = 0;
  let lives = 3;
  let level = 1;
  let pellets;
  let remaining;
  let player;
  let enemies;
  let queuedDirection = 'left';
  let powerRemaining = 0;
  let eatenCombo = 0;
  let invulnerable = 0;
  let elapsed = 0;
  let particles = [];
  let messages = [];
  let lastFrame = 0;
  let accumulator = 0;
  let sceneTime = 0;
  let lastStatus = '';

  const walkable = (col, row) => row >= 0 && row < ROWS && col >= 0 && col < COLS && MAZE[row][col] !== '#';
  const canMove = (entity, direction) => {
    const vector = DIRECTIONS[direction];
    return vector && walkable(entity.col + vector.x, entity.row + vector.y);
  };
  const makeEntity = (col, row, direction = 'left') => ({ col, row, direction, target: null, progress: 0 });
  const position = entity => ({
    x: entity.col + (entity.target ? (entity.target.col - entity.col) * entity.progress : 0),
    y: entity.row + (entity.target ? (entity.target.row - entity.row) * entity.progress : 0),
  });

  function saveBest() {
    try { localStorage.setItem(bestKey, String(best)); } catch { /* Optional persistence. */ }
  }

  function updateStats() {
    scoreValue.textContent = String(score).padStart(5, '0');
    bestValue.textContent = String(best).padStart(5, '0');
    levelValue.textContent = String(level).padStart(2, '0');
    livesValue.setAttribute('aria-label', `${lives} из 3 жизней`);
    for (let i = 0; i < livesValue.children.length; i++) {
      livesValue.children[i].classList.toggle('empty', i >= lives);
    }
  }

  function addScore(points) {
    score += points;
    best = Math.max(best, score);
    updateStats();
  }

  function setStatus(text) {
    if (text !== lastStatus) {
      statusText.textContent = text;
      lastStatus = text;
    }
  }

  function showOverlay(eyebrow, title, text, button, hint = 'или нажми Enter') {
    overlayEyebrow.textContent = eyebrow;
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    startButton.textContent = button;
    overlayHint.textContent = hint;
    overlay.hidden = false;
    pauseButton.disabled = state !== 'paused';
    pauseButton.textContent = state === 'paused' ? 'Продолжить' : 'Пауза';
    startButton.focus({ preventScroll: true });
  }

  function resetActors() {
    player = makeEntity(START.col, START.row);
    queuedDirection = 'left';
    enemies = GUARDS.map((guard, index) => ({
      ...makeEntity(guard.col, guard.row, index % 2 ? 'right' : 'left'),
      ...guard,
      index,
      returning: false,
      releaseDelay: 1 + index * 1.15,
    }));
    powerRemaining = 0;
    eatenCombo = 0;
    invulnerable = 2;
    elapsed = 0;
    particles = [];
    messages = [];
  }

  function prepareLevel() {
    pellets = MAZE.map(row => Array.from(row, cell => cell === '.' || cell === 'o' ? cell : ' '));
    // The four starting pads are clear, so no collectible is hidden beneath a guard.
    for (const guard of GUARDS) pellets[guard.row][guard.col] = ' ';
    remaining = pellets.flat().filter(cell => cell !== ' ').length;
    resetActors();
    updateStats();
  }

  function resume() {
    state = 'running';
    overlay.hidden = true;
    pauseButton.disabled = false;
    pauseButton.textContent = 'Пауза';
    canvas.focus({ preventScroll: true });
    accumulator = 0;
    lastFrame = performance.now();
    setStatus('Собирай искры. Береги свой свет.');
  }

  function primaryAction() {
    if (state === 'levelComplete') {
      level++;
      prepareLevel();
    } else if (state === 'gameOver') {
      score = 0;
      lives = 3;
      level = 1;
      prepareLevel();
    } else if (state === 'running') {
      return;
    }
    resume();
  }

  function restart() {
    saveBest();
    score = 0;
    lives = 3;
    level = 1;
    prepareLevel();
    resume();
  }

  function togglePause() {
    if (state === 'running') {
      state = 'paused';
      saveBest();
      showOverlay('МОЖНО НЕМНОГО ВЫДОХНУТЬ', 'Свет подождёт.', 'Лабиринт на паузе. Продолжай, когда будешь готов.', 'Продолжить →', 'Enter, пробел или P');
      setStatus('Пауза — время остановилось');
    } else if (state === 'paused') {
      resume();
    }
  }

  function burst(col, row, color, count = 8) {
    if (reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 15 + Math.random() * 36;
      particles.push({ x: (col + 0.5) * TILE, y: (row + 0.5) * TILE, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.4, color });
    }
    if (particles.length > 100) particles.splice(0, particles.length - 100);
  }

  function collect() {
    const cell = pellets[player.row][player.col];
    if (cell === ' ') return;
    pellets[player.row][player.col] = ' ';
    remaining--;
    if (cell === 'o') {
      addScore(50);
      powerRemaining = Math.max(4.5, 7 - (level - 1) * 0.25);
      eatenCombo = 0;
      burst(player.col, player.row, '#a9e5c1', 18);
      messages.push({ ...position(player), text: '+50', life: 1.1, color: '#b5edcb' });
      // Reverse at the next junction when a charge activates.
      for (const enemy of enemies) enemy.reversePending = !enemy.returning;
    } else {
      addScore(10);
      burst(player.col, player.row, '#f6ce68', 3);
    }
    if (remaining === 0) {
      addScore(500);
      state = 'levelComplete';
      saveBest();
      showOverlay('ЛАБИРИНТ ПРОЙДЕН · БОНУС +500', 'Вот это свет!', `Все искры собраны. На уровне ${level + 1} стражи станут быстрее. Жизни и счёт сохраняются.`, `Уровень ${level + 1} →`);
      setStatus(`Уровень ${level} пройден — все искры собраны`);
    }
  }

  // Move exactly between tile centers. Turns are buffered; reversal is immediate.
  function advance(entity, distance, choose, arrive = () => {}) {
    while (distance > 0 && state === 'running') {
      if (!entity.target) {
        const direction = choose(entity);
        if (!direction || !canMove(entity, direction)) return;
        entity.direction = direction;
        const vector = DIRECTIONS[direction];
        entity.target = { col: entity.col + vector.x, row: entity.row + vector.y };
      }
      const travel = Math.min(distance, 1 - entity.progress);
      entity.progress += travel;
      distance -= travel;
      if (entity.progress >= 1 - 1e-9) {
        entity.col = entity.target.col;
        entity.row = entity.target.row;
        entity.target = null;
        entity.progress = 0;
        arrive(entity);
      }
    }
  }

  function queueDirection(direction) {
    if (state === 'ready') primaryAction();
    if (state !== 'running') return;
    queuedDirection = direction;
    if (player.target && DIRECTIONS[player.direction].opposite === direction) {
      const previous = { col: player.col, row: player.row };
      player.col = player.target.col;
      player.row = player.target.row;
      player.target = previous;
      player.progress = 1 - player.progress;
      player.direction = direction;
    }
  }

  function choosePlayer(entity) {
    if (canMove(entity, queuedDirection)) return queuedDirection;
    return canMove(entity, entity.direction) ? entity.direction : null;
  }

  // A real path distance keeps every guard navigating even around long walls.
  function distanceMap(target) {
    let destination = target;
    if (!walkable(destination.col, destination.row)) {
      let nearest = Infinity;
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          if (!walkable(col, row)) continue;
          const distance = Math.abs(col - target.col) + Math.abs(row - target.row);
          if (distance < nearest) {
            nearest = distance;
            destination = { col, row };
          }
        }
      }
    }
    const distances = Array.from({ length: ROWS }, () => Array(COLS).fill(Infinity));
    const queue = [destination];
    distances[destination.row][destination.col] = 0;
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (const vector of Object.values(DIRECTIONS)) {
        const col = cell.col + vector.x;
        const row = cell.row + vector.y;
        if (walkable(col, row) && distances[row][col] === Infinity) {
          distances[row][col] = distances[cell.row][cell.col] + 1;
          queue.push({ col, row });
        }
      }
    }
    return distances;
  }

  function guardTarget(enemy) {
    if (enemy.returning) return GUARDS[enemy.index];
    const scatter = elapsed < 5 || elapsed % 24 > 19;
    if (scatter) return enemy.corner;
    const ahead = DIRECTIONS[player.direction];
    if (enemy.personality === 'ambush') return { col: player.col + ahead.x * 4, row: player.row + ahead.y * 4 };
    if (enemy.personality === 'flank') return { col: player.col + ahead.x * 2 - ahead.y * 3, row: player.row + ahead.y * 2 + ahead.x * 3 };
    if (enemy.personality === 'wander' && Math.hypot(enemy.col - player.col, enemy.row - player.row) < 5) return enemy.corner;
    return { col: player.col, row: player.row };
  }

  function chooseGuard(enemy) {
    if (enemy.returning && enemy.col === GUARDS[enemy.index].col && enemy.row === GUARDS[enemy.index].row) {
      enemy.returning = false;
      enemy.releaseDelay = 1.5;
      return null;
    }
    let options = Object.keys(DIRECTIONS).filter(direction => canMove(enemy, direction));
    const opposite = DIRECTIONS[enemy.direction].opposite;
    if (enemy.reversePending && options.includes(opposite)) {
      enemy.reversePending = false;
      return opposite;
    }
    enemy.reversePending = false;
    if (!enemy.returning && options.length > 1) options = options.filter(direction => direction !== opposite);
    const frightened = powerRemaining > 0 && !enemy.returning;
    const distances = distanceMap(frightened ? { col: player.col, row: player.row } : guardTarget(enemy));
    let bestDirection = options[0];
    let bestDistance = frightened ? -Infinity : Infinity;
    for (const direction of options) {
      const vector = DIRECTIONS[direction];
      const distance = distances[enemy.row + vector.y][enemy.col + vector.x];
      if (frightened ? distance > bestDistance : distance < bestDistance) {
        bestDistance = distance;
        bestDirection = direction;
      }
    }
    return bestDirection;
  }

  function loseLife() {
    lives--;
    saveBest();
    if (lives <= 0) {
      state = 'gameOver';
      updateStats();
      showOverlay('КАЖДЫЙ ФИНИШ — НОВОЕ НАЧАЛО', 'Попробуем ещё?', `Твой счёт: ${score.toLocaleString('ru-RU')}. Рекорд: ${best.toLocaleString('ru-RU')}. Лабиринт ждёт следующую попытку.`, 'Играть снова →');
      setStatus('Игра окончена. Твой свет вернётся.');
    } else {
      state = 'lifeLost';
      resetActors();
      updateStats();
      showOverlay('НЕ ВСЕ ПОВОРОТЫ ДАЮТСЯ СРАЗУ', 'Искра ещё с тобой.', `Осталось жизней: ${lives}. Собранные точки и счёт сохраняются. Первые 2 секунды ты защищён.`, 'Продолжить →');
      setStatus(`Потеряна жизнь. Осталось: ${lives}`);
    }
  }

  function checkCollisions() {
    const current = position(player);
    for (const enemy of enemies) {
      if (enemy.returning || enemy.releaseDelay > 0) continue;
      const other = position(enemy);
      if (Math.hypot(current.x - other.x, current.y - other.y) >= 0.65) continue;
      if (powerRemaining > 0) {
        const points = 200 * 2 ** Math.min(eatenCombo++, 3);
        addScore(points);
        enemy.returning = true;
        enemy.reversePending = false;
        messages.push({ ...other, text: `+${points}`, life: 1.2, color: '#b5edcb' });
        burst(other.x, other.y, '#a9e5c1', 12);
      } else if (invulnerable <= 0) {
        loseLife();
        return;
      }
    }
  }

  function update(dt) {
    elapsed += dt;
    powerRemaining = Math.max(0, powerRemaining - dt);
    invulnerable = Math.max(0, invulnerable - dt);
    advance(player, dt * Math.min(7, 5.8 + (level - 1) * 0.08), choosePlayer, collect);
    if (state !== 'running') return;
    for (const enemy of enemies) {
      if (enemy.releaseDelay > 0) {
        enemy.releaseDelay = Math.max(0, enemy.releaseDelay - dt);
        continue;
      }
      const speed = enemy.returning ? 8 : powerRemaining > 0 ? 2.7 : Math.min(6.1, 4.05 + (level - 1) * 0.18 + enemy.index * 0.035);
      advance(enemy, dt * speed, chooseGuard);
    }
    checkCollisions();
    for (const particle of particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.life -= dt;
    }
    particles = particles.filter(particle => particle.life > 0);
    for (const message of messages) message.life -= dt;
    messages = messages.filter(message => message.life > 0);
    if (state === 'running') {
      setStatus(powerRemaining > 0 ? `Сила заряда · ${Math.ceil(powerRemaining)} сек. — догоняй стражей!` : `Осталось искр: ${remaining} · Уровень ${level}`);
    }
  }

  // Cache the static walls. All artwork is drawn here from original simple shapes.
  const background = document.createElement('canvas');
  background.width = WIDTH;
  background.height = HEIGHT;
  const bg = background.getContext('2d');
  bg.fillStyle = '#0d1919';
  bg.fillRect(0, 0, WIDTH, HEIGHT);
  const wallAt = (col, row) => MAZE[row]?.[col] === '#';
  bg.fillStyle = '#1c393b';
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!wallAt(col, row)) continue;
      const x = col * TILE;
      const y = row * TILE;
      bg.beginPath();
      bg.roundRect(x + 3, y + 3, TILE - 6, TILE - 6, 6);
      bg.fill();
      if (wallAt(col + 1, row)) bg.fillRect(x + 15, y + 3, TILE, 24);
      if (wallAt(col, row + 1)) bg.fillRect(x + 3, y + 15, 24, TILE);
      if (wallAt(col + 1, row) && wallAt(col, row + 1) && wallAt(col + 1, row + 1)) bg.fillRect(x + 15, y + 15, TILE, TILE);
    }
  }
  bg.strokeStyle = '#396060';
  bg.lineWidth = 1;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!wallAt(col, row)) continue;
      const x = col * TILE;
      const y = row * TILE;
      bg.beginPath();
      if (!wallAt(col, row - 1)) { bg.moveTo(x + (wallAt(col - 1, row) ? 0 : 8), y + 3); bg.lineTo(x + (wallAt(col + 1, row) ? 30 : 22), y + 3); }
      if (!wallAt(col, row + 1)) { bg.moveTo(x + (wallAt(col - 1, row) ? 0 : 8), y + 27); bg.lineTo(x + (wallAt(col + 1, row) ? 30 : 22), y + 27); }
      if (!wallAt(col - 1, row)) { bg.moveTo(x + 3, y + (wallAt(col, row - 1) ? 0 : 8)); bg.lineTo(x + 3, y + (wallAt(col, row + 1) ? 30 : 22)); }
      if (!wallAt(col + 1, row)) { bg.moveTo(x + 27, y + (wallAt(col, row - 1) ? 0 : 8)); bg.lineTo(x + 27, y + (wallAt(col, row + 1) ? 30 : 22)); }
      bg.stroke();
    }
  }

  function drawPlayer(time) {
    const location = position(player);
    const x = (location.x + 0.5) * TILE;
    const y = (location.y + 0.5) * TILE;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(DIRECTIONS[player.direction].angle);
    if (invulnerable > 0 && state === 'running' && !reducedMotion) ctx.globalAlpha = 0.65 + Math.sin(time * 14) * 0.25;
    if (player.target && state === 'running') {
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = `rgba(246, 206, 104, ${0.18 / i})`;
        ctx.beginPath();
        ctx.arc(-9 - i * 5, 0, 3.5 - i * 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.shadowColor = powerRemaining > 0 ? '#b5edcb' : '#edc266';
    ctx.shadowBlur = powerRemaining > 0 ? 18 : 10;
    ctx.fillStyle = '#f6ce68';
    ctx.beginPath();
    ctx.arc(0, 0, 10.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffe9ac';
    ctx.beginPath();
    ctx.ellipse(-3, -4, 3.7, 2, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#24332c';
    ctx.beginPath();
    ctx.roundRect(2, -6, 6, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#f6ce68';
    ctx.fillRect(4, -3.5, 2, 2);
    ctx.fillRect(4, 1.5, 2, 2);
    if (powerRemaining > 0) {
      ctx.strokeStyle = '#b5edcb';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGuard(enemy, time) {
    const location = position(enemy);
    const x = (location.x + 0.5) * TILE;
    const y = (location.y + 0.5) * TILE;
    const frightened = powerRemaining > 0 && !enemy.returning;
    const warning = frightened && powerRemaining < 2 && !reducedMotion && Math.sin(time * 12) > 0;
    const color = enemy.returning ? '#657f77' : frightened ? (warning ? '#dcefe5' : '#8bcdb0') : enemy.color;
    ctx.save();
    ctx.translate(x, y + (state === 'running' && !reducedMotion ? Math.sin(time * 5 + enemy.index) * 0.7 : 0));
    if (enemy.releaseDelay > 0) ctx.globalAlpha = 0.55;
    if (enemy.returning) ctx.globalAlpha = 0.7;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = enemy.returning ? 0 : 6;
    ctx.beginPath();
    ctx.roundRect(-10.5, -9.5, 21, 20, [7, 7, 5, 5]);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(0, -13);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, -14, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#20312e';
    ctx.beginPath();
    ctx.roundRect(-8, -4, 16, 8, 3);
    ctx.fill();
    const look = DIRECTIONS[enemy.direction];
    ctx.fillStyle = '#f0f6ec';
    if (frightened) {
      ctx.fillRect(-5, -1, 3, 2);
      ctx.fillRect(2, -1, 3, 2);
    } else {
      ctx.beginPath();
      ctx.arc(-3.7 + look.x * 0.9, look.y * 1.2, 2, 0, Math.PI * 2);
      ctx.arc(3.7 + look.x * 0.9, look.y * 1.2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha *= 0.6;
    ctx.fillStyle = '#20312e';
    ctx.fillRect(-4, 7, 8, 1.5);
    ctx.restore();
  }

  function draw(time) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(background, 0, 0);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cell = pellets[row][col];
        if (cell === ' ') continue;
        const x = (col + 0.5) * TILE;
        const y = (row + 0.5) * TILE;
        if (cell === 'o') {
          const pulse = reducedMotion ? 0 : Math.sin(time * 3) * 1.2;
          ctx.strokeStyle = '#89bd9e';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 8 + pulse, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#b5edcb';
          ctx.shadowColor = '#8bcdb0';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = '#dfd9ad';
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // Small docking-pad marks distinguish the center from the other corridors.
    ctx.strokeStyle = '#42655a';
    ctx.lineWidth = 1;
    for (const guard of GUARDS) {
      ctx.beginPath();
      ctx.moveTo(guard.col * TILE + 11, guard.row * TILE + 26);
      ctx.lineTo(guard.col * TILE + 19, guard.row * TILE + 26);
      ctx.stroke();
    }
    for (const enemy of enemies) drawGuard(enemy, time);
    drawPlayer(time);
    for (const particle of particles) {
      ctx.globalAlpha = Math.min(1, particle.life / 0.3);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x - 1, particle.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = 'bold 13px ui-monospace, monospace';
    for (const message of messages) {
      ctx.globalAlpha = Math.min(1, message.life * 2);
      ctx.fillStyle = message.color;
      ctx.fillText(message.text, (message.x + 0.5) * TILE, (message.y + 0.5) * TILE - 14 - (1.2 - message.life) * 16);
    }
    ctx.globalAlpha = 1;
  }

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(WIDTH * ratio);
    canvas.height = Math.round(HEIGHT * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(sceneTime);
  }

  function frame(timestamp) {
    const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.1) : 0;
    lastFrame = timestamp;
    if (state === 'running') {
      sceneTime += dt;
      accumulator += dt;
      while (accumulator >= STEP && state === 'running') {
        update(STEP);
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    draw(sceneTime);
    requestAnimationFrame(frame);
  }

  const keyDirections = {
    ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right',
    KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right',
  };
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const direction = keyDirections[event.code];
    if (direction) {
      event.preventDefault();
      queueDirection(direction);
    } else if (event.code === 'Space' || event.code === 'KeyP' || event.code === 'Escape') {
      // Preserve native button activation with Space; keyboard pause works on the board.
      if (event.code === 'Space' && event.target.closest('button')) return;
      event.preventDefault();
      if (event.repeat) return;
      if (state === 'ready' && event.code === 'Space') primaryAction();
      else togglePause();
    } else if (event.code === 'Enter' && !event.repeat && !event.target.closest('button, a')) {
      event.preventDefault();
      if (state !== 'running') primaryAction();
    }
  });
  startButton.addEventListener('click', primaryAction);
  pauseButton.addEventListener('click', togglePause);
  document.getElementById('restartButton').addEventListener('click', restart);
  for (const button of document.querySelectorAll('[data-direction]')) {
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      queueDirection(button.dataset.direction);
    });
    button.addEventListener('click', event => {
      if (event.detail === 0) queueDirection(button.dataset.direction);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'running') togglePause();
    if (document.hidden) saveBest();
  });
  window.addEventListener('pagehide', saveBest);
  window.addEventListener('resize', resizeCanvas);

  // Start the scene.
  prepareLevel();
  resizeCanvas();
  requestAnimationFrame(frame);
})();

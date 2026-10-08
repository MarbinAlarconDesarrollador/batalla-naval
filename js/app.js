/* =====================================================================
   CONSTANTES Y ESTADO
   ===================================================================== */
const N = 10;
const COLS = "ABCDEFGHIJ";
const SHIPS = [
  { name: "Portaviones", size: 5 },
  { name: "Buque", size: 4 },
  { name: "Crucero", size: 3 },
  { name: "Submarino", size: 3 },
  { name: "Destructor", size: 2 },
];
const $ = (s) => document.querySelector(s);
const grid = (v) => Array.from({ length: N }, () => Array(N).fill(v));

let peer = null,
  conn = null,
  isHost = false,
  peerId = null,
  connecting = false;
let G; // estado de la partida

/** Reinicia el estado de una partida (la conexión se conserva). */
function newGame() {
  if (G && G.countdownTimer) clearInterval(G.countdownTimer);
  const countdownOverlay = document.getElementById("countdownOverlay");
  if (countdownOverlay) {
    countdownOverlay.classList.remove("show");
    countdownOverlay.setAttribute("aria-hidden", "true");
  }
  G = {
    phase: "setup", // setup | countdown | battle | over
    countdownTimer: null,
    countdownRunId: 0,
    own: grid(-1), // índice de barco en cada celda (-1 = agua)
    placed: Array(SHIPS.length).fill(null), // {cells, hits} por barco
    incoming: grid(null), // disparos recibidos: null | 'hit' | 'miss'
    attack: grid(null), // disparos enviados: null | 'hit' | 'miss' | 'sunk'
    sunkEnemy: [], // nombres de barcos enemigos hundidos
    sunkShips: [],
    stats: { shots: 0, hits: 0, recv: 0, recvHits: 0, t0: 0 }, // para la pantalla final // {name, cells} de barcos enemigos hundidos
    sel: 0,
    horiz: true,
    hover: null,
    ready: false,
    oppReady: false,
    myTurn: false,
    waiting: false,
    winner: null,
  };
}

/* =====================================================================
   COLOCACIÓN DE BARCOS
   ===================================================================== */
function shipCells(size, x, y, horiz) {
  return Array.from({ length: size }, (_, i) =>
    horiz ? [x + i, y] : [x, y + i],
  );
}
/** Comprueba que todas las casillas estén dentro del tablero y libres. */
function canPlace(cells) {
  return cells.every(
    ([x, y]) => x >= 0 && y >= 0 && x < N && y < N && G.own[y][x] === -1,
  );
}
/** Coloca el barco i en el tablero propio si cabe; devuelve true/false. */
function placeShip(i, x, y, horiz) {
  const cells = shipCells(SHIPS[i].size, x, y, horiz);
  if (!canPlace(cells)) return false;
  cells.forEach(([cx, cy]) => (G.own[cy][cx] = i));
  G.placed[i] = { cells, hits: 0 };
  return true;
}
/** Recoge un barco del tablero para poder moverlo. */
function removeShip(i) {
  if (!G.placed[i]) return;
  G.placed[i].cells.forEach(([x, y]) => (G.own[y][x] = -1));
  G.placed[i] = null;
}
/** Índice del siguiente barco sin colocar (-1 si ya están todos). */
function nextUnplaced() {
  return G.placed.findIndex((p) => !p);
}
/** Coloca toda la flota en posiciones aleatorias válidas. */
function randomFleet() {
  G.own = grid(-1);
  G.placed.fill(null);
  SHIPS.forEach((_, i) => {
    let ok = false;
    while (!ok)
      ok = placeShip(
        i,
        Math.floor(Math.random() * N),
        Math.floor(Math.random() * N),
        Math.random() < 0.5,
      );
  });
  G.sel = -1;
}

/* =====================================================================
   RED (PeerJS)
   ===================================================================== */
function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

/** Crea el Peer (anfitrión con ID MA-XXXXXX; invitado con ID automático) y gestiona errores. */
function initPeer(onOpen) {
  peer = new Peer(isHost ? genId() : undefined); // anfitrión: ID corto MA-XXXXXX
  if (isHost) hostListen();
  peer.on("open", (id) => {
    peerId = id;
    onOpen(id);
    ui();
  });
  peer.on("error", (err) => {
    // ID repetido en el servidor: genera otro y reintenta
    if (err.type === "unavailable-id" && isHost && idTries++ < 8) {
      peer.destroy();
      return initPeer(onOpen);
    }
    connecting = false;
    $("#connMsg").textContent =
      err.type === "peer-unavailable"
        ? "No se encontró ese ID. Revisa que sea correcto."
        : "Error de conexión: " + err.type;
    ui();
  });
}

/** Botón «Generar mi ID»: el jugador 1 se vuelve anfitrión y espera a su rival. */
function createRoom() {
  isHost = true;
  idTries = 0;
  $("#btnCreate").disabled = true;
  initPeer((id) => {
    $("#myId").textContent = id;
    $("#btnCopy").disabled = false;
  });
}

/** Botón «Conectar»: el jugador 2 normaliza el ID escrito y se conecta al anfitrión. */
function joinRoom() {
  const target = normId($("#peerInput").value);
  if (!target) return;
  isHost = false;
  connecting = true;
  $("#connMsg").textContent = "Conectando…";
  initPeer(() =>
    setupConn(peer.connect(target, { reliable: true, serialization: "json" })),
  );
  ui();
}

/** Configura los eventos de la conexión: abierta, datos recibidos, cierre y error. */
function setupConn(c) {
  conn = c;
  c.on("open", () => {
    connecting = false;
    $("#connMsg").textContent = "¡Conectado!";
    SND.play("connect");
    ui();
  });
  c.on("data", onData);
  c.on("close", () => {
    conn = null;
    if (G.phase !== "over") {
      G.phase = "over";
      G.winner = "abort";
    }
    ui();
  });
  c.on("error", () => ui());
}

/* =====================================================================
   PROTOCOLO DE MENSAJES
   READY | START{first} | ATTACK{x,y} | ATTACK_RESULT{x,y,result,ship,cells,gameOver} | RESTART
   ===================================================================== */
function onData(m) {
  if (!m || typeof m !== "object") return;
  switch (m.type) {
    case "READY":
      G.oppReady = true;
      break;
    case "START": // solo lo envía el anfitrión
      if (G.phase === "setup" && G.ready && G.oppReady) beginCountdown(m.first);
      break;
    case "ATTACK":
      handleAttack(m);
      break;
    case "ATTACK_RESULT":
      handleResult(m);
      break;
    case "RESTART":
      newGame();
      randomFleet();
      $("#connMsg").textContent =
        "El rival reinició la partida. Nueva ronda preparada.";
      break;
  }
  ui();
}

/** Recibimos un disparo: evaluarlo, responder y pasar el turno a nosotros. */
function handleAttack({ x, y }) {
  const valid =
    G.phase === "battle" &&
    !G.myTurn &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < N &&
    y < N &&
    G.incoming[y][x] === null;
  if (!valid) return; // mensaje fuera de turno o repetido: se ignora

  const idx = G.own[y][x];
  const res = { type: "ATTACK_RESULT", x, y, result: "miss" };
  if (idx < 0) {
    G.incoming[y][x] = "miss";
  } else {
    G.incoming[y][x] = "hit";
    const s = G.placed[idx];
    s.hits++;
    res.result = "hit";
    if (s.hits === SHIPS[idx].size) {
      res.result = "sunk";
      res.ship = SHIPS[idx].name;
      res.cells = s.cells;
    }
  }
  const lost = G.placed.every((s, i) => s.hits === SHIPS[i].size);
  res.gameOver = lost;
  send(res);
  SND.result(res.result, lost, false);
  G.stats.recv++;
  if (res.result !== "miss") G.stats.recvHits++;
  if (lost) {
    G.phase = "over";
    G.winner = "opp";
  } else G.myTurn = true;
}

/** Recibimos el resultado de NUESTRO disparo. */
function handleResult({ x, y, result, ship, cells, gameOver }) {
  if (!G.waiting) return;
  G.waiting = false;
  SND.result(result, gameOver, true);
  G.stats.shots++;
  if (result !== "miss") G.stats.hits++;
  G.attack[y][x] = result === "miss" ? "miss" : "hit";
  if (result === "sunk") {
    (cells || []).forEach(([cx, cy]) => (G.attack[cy][cx] = "sunk"));
    G.sunkEnemy.push(ship);
    G.sunkShips.push({ name: ship, cells: cells || [] });
  }
  if (gameOver) {
    G.phase = "over";
    G.winner = "me";
  } else G.myTurn = false;
}

/* =====================================================================
   ACCIONES DEL USUARIO
   ===================================================================== */
function fireAt(x, y) {
  if (G.phase !== "battle" || !G.myTurn || G.waiting || G.attack[y][x] !== null)
    return;
  G.waiting = true;
  SND.play("fire");
  send({ type: "ATTACK", x, y });
  ui();
}

/** Marca la flota como lista y avisa al rival. */
function markReady() {
  G.ready = true;
  G.hover = null;
  send({ type: "READY" });
  ui();
}

/** Solo el anfitrión: sortea quién empieza, avisa al rival e inicia la cuenta regresiva. */
function startBattle() {
  if (
    !isHost ||
    !conn ||
    !conn.open ||
    G.phase !== "setup" ||
    !G.ready ||
    !G.oppReady
  )
    return;
  const first = Math.random() < 0.5 ? "host" : "guest";
  send({ type: "START", first, countdown: 5 });
  beginCountdown(first);
}

/** Muestra la cuenta regresiva de 5 segundos y luego empieza la fase de batalla. */
function beginCountdown(first) {
  if (G.phase === "battle" || G.phase === "over") return;
  if (G.countdownTimer) clearInterval(G.countdownTimer);
  const runId = ++G.countdownRunId;
  G.phase = "countdown";
  G.myTurn = false;
  G.waiting = false;
  const overlay = $("#countdownOverlay"),
    number = $("#countdownNumber"),
    text = $("#countdownText");
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  let n = 5;
  number.textContent = n;
  text.textContent = "Prepárate…";
  SND.play("horn", 0.45);
  ui();
  G.countdownTimer = setInterval(() => {
    if (runId !== G.countdownRunId || G.phase !== "countdown") {
      clearInterval(G.countdownTimer);
      G.countdownTimer = null;
      return;
    }
    n--;
    if (n > 0) {
      number.textContent = n;
      text.textContent = n === 1 ? "¡A los puestos!" : "Prepárate…";
      SND.play("click", 0.7);
    } else {
      clearInterval(G.countdownTimer);
      G.countdownTimer = null;
      number.textContent = "¡YA!";
      text.textContent = "¡Comienza la batalla!";
      SND.play("horn", 0.75);
      setTimeout(() => {
        if (runId !== G.countdownRunId || G.phase !== "countdown") return;
        overlay.classList.remove("show");
        overlay.setAttribute("aria-hidden", "true");
        G.phase = "battle";
        G.myTurn = first === (isHost ? "host" : "guest");
        G.stats.t0 = Date.now();
        ui();
      }, 650);
    }
  }, 1000);
}

/** Abre la ventana de confirmación para jugar de nuevo. */
function askRestart() {
  if (G.phase !== "over" || !conn || !conn.open) return;
  const overlay = $("#restartOverlay");
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  $("#btnCancelRestart").focus();
}
/** Cierra la ventana de confirmación de reinicio. */
function closeRestartDialog() {
  const overlay = $("#restartOverlay");
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
}
/** Atajo del botón «Jugar de nuevo»: pide confirmación. */
function restart() {
  askRestart();
}
/** Reinicia la partida en ambos jugadores y deja una flota aleatoria lista. */
function confirmRestart() {
  if (G.phase !== "over" || !conn || !conn.open) {
    closeRestartDialog();
    return;
  }
  closeRestartDialog();
  send({ type: "RESTART" });
  newGame();
  randomFleet();
  $("#connMsg").textContent = "Nueva partida preparada.";
  ui();
}

/* =====================================================================
   INTERFAZ
   ===================================================================== */
const ownEls = [],
  atkEls = [];

/** Construye un tablero 10x10 con etiquetas (A–J, 1–10) y casillas clicables. */
function buildBoard(el, store, onClick, onHover) {
  el.innerHTML =
    '<div class="lbl"></div>' +
    [...COLS].map((c) => `<div class="lbl">${c}</div>`).join("");
  for (let y = 0; y < N; y++) {
    el.insertAdjacentHTML("beforeend", `<div class="lbl">${y + 1}</div>`);
    store[y] = [];
    for (let x = 0; x < N; x++) {
      const b = document.createElement("button");
      b.className = "cell";
      b.type = "button";
      b.setAttribute("aria-label", `${COLS[x]}${y + 1}`);
      b.addEventListener("click", () => onClick(x, y));
      if (onHover) {
        b.addEventListener("mouseenter", () => onHover(x, y));
        b.addEventListener("focus", () => onHover(x, y));
      }
      el.appendChild(b);
      store[y][x] = b;
    }
  }
  [...el.children].forEach((c, i) => {
    c.style.gridColumn = (i % 11) + 1;
    c.style.gridRow = Math.floor(i / 11) + 1;
  });
  if (onHover)
    el.addEventListener("mouseleave", () => {
      G.hover = null;
      render();
    });
}

/** Clic en nuestro tablero: coloca el barco seleccionado o recoge uno ya colocado. */
function ownClick(x, y) {
  if (G.phase !== "setup" || G.ready) return;
  if (G.sel >= 0 && placeShip(G.sel, x, y, G.horiz)) {
    G.sel = nextUnplaced();
    SND.play("place");
  } else if (G.own[y][x] >= 0) {
    const i = G.own[y][x];
    removeShip(i);
    G.sel = i;
    SND.play("remove");
  } // recoger barco
  ui();
}

/** Dibuja los tableros (barcos, impactos, vista previa), la lista de flota y las imágenes de barcos. */
function render() {
  const previewing = G.phase === "setup" && !G.ready && G.hover && G.sel >= 0;
  const pv = previewing
    ? shipCells(SHIPS[G.sel].size, G.hover.x, G.hover.y, G.horiz)
    : [];
  const pvOk = previewing && canPlace(pv);

  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let c = "cell";
      if (G.own[y][x] >= 0) c += " ship";
      if (G.incoming[y][x]) c += " " + G.incoming[y][x];
      if (pv.some(([px, py]) => px === x && py === y))
        c += pvOk ? " pv" : " bad";
      ownEls[y][x].className = c;

      const a = G.attack[y][x];
      atkEls[y][x].className = "cell" + (a ? " " + a : " open");
      atkEls[y][x].disabled = !!a;
    }
  $("#atkBoard").classList.toggle(
    "live",
    G.phase === "battle" && G.myTurn && !G.waiting,
  );

  // Lista de flota propia
  $("#fleet").innerHTML = "";
  SHIPS.forEach((s, i) => {
    const b = document.createElement("button");
    const sunk = G.placed[i] && G.placed[i].hits === s.size;
    b.className =
      "chip" +
      (G.placed[i] ? " placed" : "") +
      (G.sel === i ? " sel" : "") +
      (sunk ? " sunk" : "");
    b.textContent = `${s.name} (${s.size})`;
    b.disabled = G.phase !== "setup" || G.ready;
    b.onclick = () => {
      if (G.placed[i]) removeShip(i);
      G.sel = i;
      ui();
    };
    $("#fleet").appendChild(b);
  });
  drawShips();
  // Flota enemiga (hundidos)
  $("#enemyFleet").innerHTML = SHIPS.map(
    (s) =>
      `<span class="chip${G.sunkEnemy.includes(s.name) ? " sunk" : ""}">${s.name} (${s.size})</span>`,
  ).join("");
}

/** Actualiza estado de conexión, banner de turno, botones y comprueba si hay que mostrar el resultado. */
function ui() {
  render();
  const open = !!(conn && conn.open);

  // Estado de conexión
  const st = $("#status");
  let txt = "Desconectado",
    cls = "";
  if (open) {
    txt = "Conectado";
    cls = "on";
  } else if (connecting || (isHost && peerId)) {
    txt = connecting ? "Conectando…" : "Esperando rival";
    cls = "wait";
  }
  st.className = "pill " + cls;
  $("#statusTxt").textContent = txt;
  $("#connPanel").hidden = open;

  // Banner de turno / estado
  const bn = $("#banner");
  let t = "",
    k = "";
  if (G.phase === "over") {
    if (G.winner === "me") {
      t = "¡Victoria! Hundiste toda la flota rival";
      k = "mine";
    } else if (G.winner === "opp") {
      t = "Derrota: tu flota fue hundida";
      k = "theirs";
    } else t = "El rival se desconectó. Recarga la página para jugar de nuevo.";
  } else if (!open) t = "Conecta con tu rival para empezar";
  else if (G.phase === "setup") {
    t = !G.ready
      ? "Coloca tu flota"
      : G.oppReady
        ? isHost
          ? "Ambos listos: pulsa «Iniciar batalla»"
          : "Ambos listos: el anfitrión iniciará la batalla"
        : "Esperando a que el rival esté listo…";
  } else if (G.phase === "countdown") {
    t = "La batalla comienza en…";
    k = "mine";
  } else if (G.waiting) {
    t = "Disparo enviado, esperando resultado…";
    k = "mine";
  } else if (G.myTurn) {
    t = "Tu turno: elige una casilla de las aguas enemigas";
    k = "mine";
  } else {
    t = "Turno del rival";
    k = "theirs";
  }
  bn.textContent = t;
  bn.className = k;
  bn.id = "banner";

  // Estado del rival
  $("#oppState").textContent = !open
    ? "El rival aún no está conectado."
    : G.phase === "setup"
      ? G.oppReady
        ? "El rival está listo."
        : "El rival está colocando su flota."
      : G.phase === "countdown"
        ? "Cuenta regresiva: prepárate para combatir…"
        : G.phase === "battle"
          ? `Barcos enemigos hundidos: ${G.sunkEnemy.length} de ${SHIPS.length}`
          : "";

  // Botones
  const setup = G.phase === "setup" && !G.ready;
  $("#btnRandom").disabled =
    $("#btnClear").disabled =
    $("#btnRotate").disabled =
      !setup;
  $("#btnRotate").textContent = G.horiz
    ? "Rotar (horizontal)"
    : "Rotar (vertical)";
  const allPlaced = G.placed.every(Boolean);
  $("#btnReady").hidden = G.phase !== "setup";
  $("#btnReady").disabled = !(setup && allPlaced && open);
  $("#btnReady").textContent = G.ready ? "Listo ✓" : "Estoy listo";
  $("#btnStart").hidden = !(isHost && G.phase === "setup");
  $("#btnStart").disabled = !(open && G.ready && G.oppReady);
  $("#btnRestart").hidden = !(G.phase === "over" && open);
  $("#hint").hidden = G.phase !== "setup";
  resultTick(); // pantalla final si la partida terminó
}

/* =====================================================================
   ARRANQUE
   ===================================================================== */
/* =====================================================================
   AUDIO (sintetizado con Web Audio: sin archivos externos)
   ===================================================================== */
const SND = (() => {
  let ctx,
    master,
    sfxG,
    musG,
    nb,
    timer,
    nextT = 0,
    step = 0,
    el = null,
    K = 1;
  const st = { music: true, sfx: true, vol: 0.7 };
  try {
    Object.assign(st, JSON.parse(localStorage.getItem("bn_audio") || "{}"));
  } catch (e) {}
  const save = () => {
    try {
      localStorage.setItem("bn_audio", JSON.stringify(st));
    } catch (e) {}
  };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  /** Crea el contexto de audio (requiere un gesto del usuario) y el buffer de ruido. */
  function init() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    sfxG = ctx.createGain();
    musG = ctx.createGain();
    sfxG.connect(master);
    musG.connect(master);
    master.connect(ctx.destination);
    nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    apply();
  }
  /** Aplica volumen y activa/desactiva la música según los ajustes guardados. */
  function apply() {
    const synth = st.music && !el;
    if (ctx) {
      master.gain.value = st.vol;
      musG.gain.setTargetAtTime(synth ? 0.55 : 0, ctx.currentTime, 0.1);
      if (synth && !timer) {
        nextT = ctx.currentTime + 0.1;
        timer = setInterval(sched, 150);
      }
      if (!synth && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
    if (el) {
      el.volume = st.vol;
      st.music ? el.play().catch(() => {}) : el.pause();
    }
    save();
  }
  /** Reproduce un tono (oscilador con envolvente), opcionalmente con deslizamiento de frecuencia. */
  function tone(f, d, type, v, when, to, out) {
    const t = ctx.currentTime + (when || 0),
      o = ctx.createOscillator(),
      g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * K, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(out || sfxG);
    o.start(t);
    o.stop(t + d + 0.05);
  }
  /** Reproduce ruido filtrado (explosiones, salpicaduras, percusión). */
  function noise(d, v, type, f0, f1, when, out) {
    const t = ctx.currentTime + (when || 0),
      s = ctx.createBufferSource(),
      fl = ctx.createBiquadFilter(),
      g = ctx.createGain();
    s.buffer = nb;
    fl.type = type;
    fl.frequency.setValueAtTime(f0, t);
    fl.frequency.exponentialRampToValueAtTime(f1, t + d);
    g.gain.setValueAtTime(v * K, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    s.connect(fl);
    fl.connect(g);
    g.connect(out || sfxG);
    s.start(t);
    s.stop(t + d);
  }
  const SFX = {
    click: () => tone(700, 0.05, "square", 0.05),
    place: () => {
      tone(200, 0.14, "triangle", 0.3, 0, 120);
      noise(0.08, 0.15, "lowpass", 900, 200);
    },
    remove: () => tone(300, 0.1, "triangle", 0.2, 0, 520),
    fire: () => {
      noise(0.4, 0.6, "lowpass", 2400, 150);
      tone(110, 0.45, "sine", 0.7, 0, 35);
    },
    miss: () => {
      noise(0.8, 0.4, "bandpass", 2000, 300);
      tone(600, 0.18, "sine", 0.1, 0, 200);
    },
    hit: () => {
      noise(1, 0.8, "lowpass", 1400, 60);
      tone(80, 0.9, "sine", 0.9, 0, 28);
    },
    sunk: () => {
      SFX.hit();
      noise(2, 0.6, "lowpass", 900, 50, 0.25);
      tone(70, 1.8, "sawtooth", 0.25, 0.2, 22);
      for (let i = 0; i < 5; i++)
        tone(500 + i * 130, 0.15, "sine", 0.08, 0.5 + i * 0.22, 1400);
    },
    turn: () => {
      tone(1250, 1, "sine", 0.14);
      tone(1250, 1, "sine", 0.06, 0.3);
    },
    horn: () =>
      [117, 156].forEach((f) => tone(f, 1.5, "sawtooth", 0.12, 0, f * 0.96)),
    connect: () => {
      tone(523, 0.15, "triangle", 0.2);
      tone(784, 0.25, "triangle", 0.2, 0.12);
    },
    win: () =>
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) =>
        tone(f, 0.35, "triangle", 0.25, i * 0.16),
      ),
    lose: () =>
      [440, 392, 349, 262].forEach((f, i) =>
        tone(f, 0.7, "sawtooth", 0.1, i * 0.35, f * 0.98),
      ),
  };
  /** Reproduce un efecto de sonido por nombre, con volumen relativo opcional. */
  function play(n, k) {
    if (!st.sfx) return;
    init();
    if (!ctx) return;
    K = k || 1;
    try {
      SFX[n]();
    } catch (e) {}
    K = 1;
  }
  /* Música: marcha lenta Am–F–C–G con pad, arpegio, tambor y ping de sonar */
  const CH = [
    [45, 52, 57, 60],
    [41, 48, 53, 57],
    [48, 55, 60, 64],
    [43, 50, 55, 59],
  ];
  const ARP = [0, 2, 1, 3, 2, 1, 3, 2];
  /** Programador de la música: agenda pads, arpegio, tambor y sonar con antelación. */
  function sched() {
    while (nextT < ctx.currentTime + 0.5) {
      const t = nextT - ctx.currentTime,
        s = step % 16,
        ch = CH[Math.floor(step / 16) % 4];
      if (s === 0)
        ch.forEach((n) => {
          const o = ctx.createOscillator(),
            f = ctx.createBiquadFilter(),
            g = ctx.createGain();
          o.type = "sawtooth";
          o.frequency.value = hz(n);
          o.detune.value = ((n % 3) - 1) * 6;
          f.type = "lowpass";
          f.frequency.value = 480;
          g.gain.setValueAtTime(0.0001, nextT);
          g.gain.linearRampToValueAtTime(0.05, nextT + 2);
          g.gain.linearRampToValueAtTime(0.0001, nextT + 8.4);
          o.connect(f);
          f.connect(g);
          g.connect(musG);
          o.start(nextT);
          o.stop(nextT + 8.5);
        });
      if (s % 2 === 0) tone(110, 0.25, "sine", 0.35, t, 40, musG);
      if (s % 4 === 2) noise(0.12, 0.07, "bandpass", 3000, 1500, t, musG);
      if (s % 2 === 1)
        tone(hz(ch[ARP[s >> 1]] + 12), 0.5, "triangle", 0.06, t, null, musG);
      if (step % 64 === 40) tone(1500, 1.2, "sine", 0.06, t, null, musG);
      step++;
      nextT += 0.5;
    }
  }
  /** Usa un archivo de audio propio como música de fondo (o vuelve a la original con null). */
  function setMusicFile(f) {
    if (el) {
      el.pause();
      URL.revokeObjectURL(el.src);
      el = null;
    }
    if (f) {
      el = new Audio(URL.createObjectURL(f));
      el.loop = true;
    }
    init();
    apply();
  }
  /** Sonido del resultado de un disparo (mine = disparo propio). */
  function result(r, over, mine) {
    if (!mine) play("fire", 0.5);
    setTimeout(
      () => {
        play(r === "miss" ? "miss" : r === "sunk" ? "sunk" : "hit");
        if (over) setTimeout(() => play(mine ? "win" : "lose"), 1400);
        else if (!mine) setTimeout(() => play("turn"), 1100);
      },
      mine ? 350 : 450,
    );
  }
  return {
    st,
    play,
    result,
    setMusicFile,
    unlock: () => {
      init();
      apply();
    },
    apply,
  };
})();

/* =====================================================================
   BARCOS: dibujos SVG por defecto + imágenes propias (localStorage)
   ===================================================================== */
const SV = (L, b) =>
  `<svg viewBox="0 0 ${L} 100" xmlns="http://www.w3.org/2000/svg">${b}</svg>`;
const OUT = 'stroke="#1b2831" stroke-width="4" stroke-linejoin="round"';
const TUR = (x, y) =>
  `<rect x="${x}" y="${y - 3}" width="34" height="6" fill="#26333b"/><circle cx="${x}" cy="${y}" r="14" fill="#7d8d96" ${OUT}/>`;
const HULL = (L, c) =>
  `<path d="M8 30 Q2 50 8 70 L${L - 60} 78 Q${L - 8} 64 ${L - 4} 50 Q${L - 8} 36 ${L - 60} 22 Z" fill="${c}" ${OUT}/>`;
const BRG = (x) =>
  `<rect x="${x}" y="38" width="60" height="24" rx="6" fill="#cfd8dc" ${OUT}/>`;
const SVGS = {
  Portaviones: (n) => {
    const L = n * 100;
    return SV(
      L,
      `<path d="M8 24 L${L - 70} 22 L${L - 6} 50 L${L - 70} 78 L8 76 Z" fill="#7d8d96" ${OUT}/><rect x="22" y="30" width="${L - 110}" height="40" fill="#46535b"/><path d="M30 50 H${L - 100}" stroke="#f2e6b1" stroke-width="3" stroke-dasharray="14 12"/><rect x="${L * 0.52}" y="66" width="64" height="16" fill="#cfd8dc" ${OUT}/><circle cx="${L * 0.2}" cy="40" r="6" fill="#e8b84a"/><circle cx="${L * 0.32}" cy="60" r="6" fill="#e8b84a"/>`,
    );
  },
  Buque: (n) => {
    const L = n * 100;
    return SV(
      L,
      HULL(L, "#8c9ba3") +
        TUR(L * 0.2, 50) +
        TUR(L * 0.38, 50) +
        BRG(L * 0.52) +
        TUR(L * 0.78, 50),
    );
  },
  Crucero: (n) => {
    const L = n * 100;
    return SV(
      L,
      HULL(L, "#95a4ac") +
        TUR(L * 0.2, 50) +
        BRG(L * 0.42) +
        `<circle cx="${L * 0.62}" cy="50" r="9" fill="#46535b" ${OUT}/>` +
        TUR(L * 0.76, 50),
    );
  },
  Submarino: (n) => {
    const L = n * 100;
    return SV(
      L,
      `<rect x="8" y="34" width="${L - 16}" height="32" rx="16" fill="#3d4b55" ${OUT}/><rect x="${L * 0.42}" y="27" width="48" height="16" rx="6" fill="#56666f" ${OUT}/><path d="M${L * 0.5} 27 V16 H${L * 0.5 + 14}" stroke="#1b2831" stroke-width="4" fill="none"/><path d="M26 46 H${L - 34}" stroke="#ffffff30" stroke-width="4" stroke-linecap="round"/>`,
    );
  },
  Destructor: (n) => {
    const L = n * 100;
    return SV(
      L,
      `<path d="M8 36 L${L - 40} 32 Q${L - 6} 50 ${L - 40} 68 L8 64 Z" fill="#a1afb6" ${OUT}/>` +
        TUR(L * 0.72, 50) +
        `<rect x="${L * 0.3}" y="40" width="40" height="20" rx="5" fill="#cfd8dc" ${OUT}/><circle cx="${L * 0.14}" cy="50" r="8" fill="#46535b" ${OUT}/>`,
    );
  },
};
let IMGS = {},
  imgRev = 0;
try {
  IMGS = JSON.parse(localStorage.getItem("bn_imgs") || "{}");
} catch (e) {}
const shipInner = (name, size) =>
  IMGS[name] ? `<img src="${IMGS[name]}" alt="${name}">` : SVGS[name](size);

const shipSig = {};
/** Dibuja los barcos como capas sobre el tablero (propios y enemigos hundidos). */
function drawShips() {
  const sets = {
    ownBoard: G.placed
      .map(
        (p, i) =>
          p && {
            name: SHIPS[i].name,
            cells: p.cells,
            dead: p.hits === SHIPS[i].size,
          },
      )
      .filter(Boolean),
    atkBoard: G.sunkShips
      .filter((s) => s.cells.length)
      .map((s) => ({ name: s.name, cells: s.cells, dead: true })),
  };
  for (const id in sets) {
    const key = JSON.stringify(sets[id]) + imgRev;
    if (shipSig[id] === key) continue;
    shipSig[id] = key;
    const el = $("#" + id);
    el.querySelectorAll(".sh").forEach((n) => n.remove());
    sets[id].forEach((s) => {
      const [x, y] = s.cells[0],
        len = s.cells.length,
        v = len > 1 && s.cells[1][0] === x;
      const d = document.createElement("div");
      d.className = "sh" + (v ? " v" : "") + (s.dead ? " dead" : "");
      d.style.gridColumn = v ? x + 2 : `${x + 2} / span ${len}`;
      d.style.gridRow = v ? `${y + 2} / span ${len}` : y + 2;
      d.innerHTML = shipInner(s.name, len);
      el.appendChild(d);
    });
  }
}

/** Guarda las imágenes personalizadas y redibuja. */
function changedImgs() {
  imgRev++;
  try {
    localStorage.setItem("bn_imgs", JSON.stringify(IMGS));
  } catch (e) {
    alert(
      "No hay espacio para guardar la imagen en el navegador; se usará solo en esta sesión.",
    );
  }
  renderCustom();
  render();
}
/** Lee una imagen subida, la reduce a 600 px y la guarda como dataURL. */
function loadImg(file, name) {
  const r = new FileReader();
  r.onload = () => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, 600 / im.width),
        c = document.createElement("canvas");
      c.width = Math.round(im.width * s);
      c.height = Math.round(im.height * s);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      IMGS[name] = c.toDataURL("image/webp", 0.85);
      changedImgs();
    };
    im.src = r.result;
  };
  r.readAsDataURL(file);
}
/** Dibuja el panel para personalizar la imagen de cada barco. */
function renderCustom() {
  const box = $("#shipCustom");
  box.innerHTML = "";
  SHIPS.forEach((s) => {
    const d = document.createElement("div");
    d.className = "cu";
    d.innerHTML = `<div class="th">${shipInner(s.name, s.size)}</div><b>${s.name} (${s.size})</b>`;
    const lab = document.createElement("label");
    lab.className = "btn alt";
    lab.textContent = IMGS[s.name] ? "Cambiar imagen" : "Subir imagen";
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.className = "vh";
    inp.onchange = () => inp.files[0] && loadImg(inp.files[0], s.name);
    lab.appendChild(inp);
    d.appendChild(lab);
    if (IMGS[s.name]) {
      const r = document.createElement("button");
      r.className = "alt";
      r.textContent = "Restaurar";
      r.onclick = () => {
        delete IMGS[s.name];
        changedImgs();
      };
      d.appendChild(r);
    }
    box.appendChild(d);
  });
}

/* Controles de audio y arranque */
const bMus = $("#btnMusic"),
  bSfx = $("#btnSfx"),
  vol = $("#vol");
/** Sincroniza botones y volumen con los ajustes de audio. */
function syncAudioUI() {
  bMus.setAttribute("aria-pressed", SND.st.music);
  bSfx.setAttribute("aria-pressed", SND.st.sfx);
  vol.value = Math.round(SND.st.vol * 100);
}
bMus.onclick = () => {
  SND.st.music = !SND.st.music;
  SND.unlock();
  syncAudioUI();
};
bSfx.onclick = () => {
  SND.st.sfx = !SND.st.sfx;
  SND.apply();
  syncAudioUI();
};
vol.oninput = () => {
  SND.st.vol = vol.value / 100;
  SND.unlock();
};
$("#musicFile").onchange = (e) => {
  if (e.target.files[0]) {
    SND.st.music = true;
    SND.setMusicFile(e.target.files[0]);
    syncAudioUI();
  }
};
$("#btnMusicReset").onclick = () => {
  SND.setMusicFile(null);
};
["pointerdown", "keydown"].forEach((ev) =>
  document.addEventListener(ev, () => SND.unlock(), { once: true }),
);
document.addEventListener("click", (e) => {
  const b = e.target.closest("button,.btn");
  if (b && !b.classList.contains("cell")) SND.play("click");
});
syncAudioUI();
renderCustom();

/* =====================================================================
   NUEVAS FUNCIONES: ID corto, tema, reglas, resultado y confeti
   ===================================================================== */
let idTries = 0,
  cfRaf = 0;

/** Genera el ID de sala: "MA-" + 6 dígitos (ej. MA-482910). Es el ID de PeerJS. */
function genId() {
  return "MA-" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
}

/** Acepta "482910", "ma-482910" o "MA 482910" y lo convierte a "MA-482910". */
function normId(v) {
  const m = v
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .match(/^(?:MA)?(\d{6})$/);
  return m ? "MA-" + m[1] : v.trim();
}

/** Anfitrión: acepta una única conexión entrante (rechaza las demás). */
function hostListen() {
  peer.on("connection", (c) => {
    if (conn && conn.open) {
      c.close();
      return;
    }
    setupConn(c);
  });
}

/** Aplica el tema ("dark" | "light") en <html data-theme> y lo recuerda. */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("bn_theme", t);
  } catch (e) {}
  $("#btnTheme").textContent = t === "dark" ? "Modo claro" : "Modo oscuro";
}
$("#btnTheme").onclick = () =>
  applyTheme(
    document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  );
applyTheme(document.documentElement.dataset.theme || "dark");

/** Abre / cierra una ventana modal (.ov) por su selector. */
function openOv(id) {
  const o = $(id);
  o.classList.add("show");
  o.setAttribute("aria-hidden", "false");
  const b = o.querySelector("button");
  if (b) b.focus();
}
function closeOv(id) {
  const o = $(id);
  o.classList.remove("show");
  o.setAttribute("aria-hidden", "true");
}
$("#btnRules").onclick = () => openOv("#rulesOverlay");
$("#btnRulesClose").onclick = () => closeOv("#rulesOverlay");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeOv("#rulesOverlay");
    closeOv("#resultOverlay");
  }
});

/** Se llama desde ui(): al terminar la partida muestra el resultado una sola vez. */
function resultTick() {
  if (G.phase !== "over" || !G.winner || G.winner === "abort") {
    hideResult();
    return;
  }
  if (!G.resultShown) {
    G.resultShown = true;
    setTimeout(showResult, 1500);
  } // espera a que suene la última explosión
}
/** Muestra victoria/derrota con estadísticas de la partida y lanza el confeti. */
function showResult() {
  if (G.phase !== "over" || !G.winner || G.winner === "abort") return;
  const s = G.stats,
    win = G.winner === "me",
    secs = Math.round((Date.now() - s.t0) / 1000);
  const lost = G.placed.filter((p, i) => p && p.hits === SHIPS[i].size).length;
  $("#resTitle").textContent = win ? "¡Victoria!" : "Derrota";
  $("#resSub").textContent = win
    ? "Hundiste toda la flota enemiga."
    : "Tu flota fue hundida.";
  const items = [
    ["Disparos", s.shots],
    ["Aciertos", s.hits],
    ["Precisión", (s.shots ? Math.round((s.hits * 100) / s.shots) : 0) + "%"],
    ["Barcos hundidos", G.sunkEnemy.length + "/" + SHIPS.length],
    ["Barcos perdidos", lost + "/" + SHIPS.length],
    ["Impactos recibidos", s.recvHits],
    [
      "Duración",
      Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0"),
    ],
  ];
  $("#resStats").innerHTML = items
    .map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`)
    .join("");
  openOv("#resultOverlay");
  confetti();
}
function hideResult() {
  closeOv("#resultOverlay");
  stopConfetti();
}
$("#btnResClose").onclick = hideResult;
$("#btnResAgain").onclick = () => {
  hideResult();
  askRestart();
};

/** Confeti en las 4 esquinas: partículas en canvas con gravedad, en 4 ráfagas. */
function stopConfetti() {
  cancelAnimationFrame(cfRaf);
  cfRaf = 0;
  const c = $("#confetti");
  c.getContext("2d").clearRect(0, 0, c.width, c.height);
}
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; // respeta accesibilidad
  stopConfetti();
  const c = $("#confetti"),
    g = c.getContext("2d"),
    W = (c.width = innerWidth),
    H = (c.height = innerHeight);
  const cols = [
    "#c9a24a",
    "#ee5a33",
    "#3fa57a",
    "#4fb3d9",
    "#f2f2f2",
    "#e86aa5",
  ];
  let ps = [],
    bursts = 0,
    last = 0;
  const burst = () => {
    [
      [0, H, 1, -1],
      [W, H, -1, -1],
      [0, 0, 1, 1],
      [W, 0, -1, 1],
    ].forEach(([x, y, dx, dy]) => {
      for (let i = 0; i < 45; i++)
        ps.push({
          x,
          y,
          vx: dx * (3 + Math.random() * 8),
          vy: dy * (3 + Math.random() * 10) * (dy < 0 ? 1.3 : 0.6),
          r: Math.random() * 6.28,
          vr: (Math.random() - 0.5) * 0.4,
          w: 6 + Math.random() * 6,
          h: 3 + Math.random() * 4,
          c: cols[i % cols.length],
          life: 0,
        });
    });
    bursts++;
  };
  const tick = (t) => {
    if (bursts < 4 && t - last > 700) {
      burst();
      last = t;
    }
    g.clearRect(0, 0, W, H);
    ps = ps.filter((p) => p.life < 260 && p.y < H + 20);
    ps.forEach((p) => {
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.22;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      p.life++;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.r);
      g.fillStyle = p.c;
      g.globalAlpha = Math.min(1, (260 - p.life) / 60);
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    });
    if (bursts < 4 || ps.length) cfRaf = requestAnimationFrame(tick);
    else g.clearRect(0, 0, W, H);
  };
  cfRaf = requestAnimationFrame(tick);
}

newGame();
buildBoard($("#ownBoard"), ownEls, ownClick, (x, y) => {
  G.hover = { x, y };
  render();
});
buildBoard($("#atkBoard"), atkEls, fireAt);

$("#btnCreate").onclick = createRoom;
$("#btnJoin").onclick = joinRoom;
$("#peerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});
$("#btnCopy").onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(peerId);
  $("#btnCopy").textContent = "Copiado";
  setTimeout(() => ($("#btnCopy").textContent = "Copiar"), 1500);
};
$("#btnRandom").onclick = () => {
  randomFleet();
  ui();
};
$("#btnClear").onclick = () => {
  G.own = grid(-1);
  G.placed.fill(null);
  G.sel = 0;
  ui();
};
$("#btnRotate").onclick = () => {
  G.horiz = !G.horiz;
  ui();
};
$("#btnReady").onclick = markReady;
$("#btnStart").onclick = startBattle;
$("#btnRestart").onclick = restart;
$("#btnCancelRestart").onclick = closeRestartDialog;
$("#btnConfirmRestart").onclick = confirmRestart;
$("#restartOverlay").addEventListener("click", (e) => {
  if (e.target === $("#restartOverlay")) closeRestartDialog();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#restartOverlay").classList.contains("show")) {
    closeRestartDialog();
    return;
  }
  if (
    (e.key === "r" || e.key === "R") &&
    !/INPUT/.test(document.activeElement.tagName)
  ) {
    G.horiz = !G.horiz;
    ui();
  }
});
ui();



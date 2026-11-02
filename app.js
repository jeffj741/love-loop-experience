// The remote contract defines allowed semantics; interaction state remains local.
// No live session, pattern evidence, or pairing is loaded by this prototype.
const fallbackContract = {
  schema_version: "love-loop.experience.v1",
  modes: ["for_me", "between_us"],
  for_me_states: ["not_measured", "settled", "rising", "guided_response", "returned"],
  between_us_states: ["not_connected", "connected", "shared_moment"],
  data_rules: {
    current_state_requires_live_session: true,
    pattern_count_requires_evidence: true,
    between_us_requires_pairing: true,
    pressureiq_detail_exposed: false
  }
};
const model = {
  contract: fallbackContract,
  source: "simulation",
  simulated: { mode: "for_me", personal: "settled", shared: "connected" },
  backend: { liveSession: null, patternEvidence: null, pairing: null },
  overlay: null,
  passenger: null
};

const SESSION_KEY = "love_loop_bearer_session";
const auth = { phase: "checking", token: null, identity: null, persistence: "session", needsAuthValidation: false, epoch: 0 };

function savedSession() {
  try {
    const token = localStorage.getItem(SESSION_KEY);
    if (token) return { token, persistence: "persistent" };
  } catch { /* Storage may be disabled. */ }
  try {
    const token = sessionStorage.getItem(SESSION_KEY);
    if (token) return { token, persistence: "session" };
  } catch { /* Storage may be disabled. */ }
  return null;
}
function clearStoredToken() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ }
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ }
}
function rememberToken(token) {
  if (!token) { clearStoredToken(); return; }
  const selected = auth.persistence === "persistent" ? localStorage : sessionStorage;
  const other = auth.persistence === "persistent" ? sessionStorage : localStorage;
  try { if (other.getItem(SESSION_KEY)) other.removeItem(SESSION_KEY); }
  catch { /* Storage may be disabled. */ }
  try { if (selected.getItem(SESSION_KEY) !== token) selected.setItem(SESSION_KEY, token); }
  catch { /* This tab retains its in-memory session. */ }
}
function lockExperience(message, retry = false) {
  auth.phase = "signed_out";
  auth.identity = null;
  model.passenger = null;
  $("#appRoot").hidden = true;
  $("#authRoot").hidden = false;
  $("#authForm").hidden = false;
  $("#authRetry").hidden = !retry;
  $("#authMessage").textContent = message;
  $("#authForm button[type=submit]").disabled = false;
}
function authMessage(status, context) {
  if (status === 401) return context === "login" ? "That email or password didn't work. Please try again." : "Your session has ended. Sign in again.";
  if (status === 403) return context === "identity"
    ? "You're signed in, but Love Loop can't open this account yet. Try again in a little while."
    : "This account can't enter Love Loop yet.";
  if (status === 429) return "Too many attempts just now. Please wait a moment and try again.";
  if (status === 503) return "Your space is temporarily unavailable. Please try again.";
  return "We couldn't connect right now. Please try again.";
}
async function authRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } finally { clearTimeout(timeout); }
}
function safePassenger(value) {
  if (!value || typeof value !== "object" || value.schema_version !== "love-loop.passenger-presence.v1") return null;
  if (value.name !== "LB" || value.role !== "passenger" || value.presence !== "standby") return null;
  if (value.conversation?.status !== "not_connected" || value.conversation?.can_send_messages !== false ||
      value.conversation?.can_generate_explanations !== false || value.between_us_access !== false) return null;
  if (value.data_rules?.raw_signals_exposed !== false || value.data_rules?.research_metrics_exposed !== false ||
      value.data_rules?.haptic_selection_allowed !== false || value.data_rules?.response_execution_allowed !== false ||
      value.data_rules?.diagnostic_claims_allowed !== false) return null;
  // Fixed local copy only. Never render arbitrary backend text, analytics or IDs.
  return { standby: true };
}

function renderPassenger() {
  const visible = auth.phase === "ready" && model.simulated.mode === "for_me" && model.passenger?.standby === true;
  const element = $("#passengerPresence");
  if (element) element.hidden = !visible;
}

async function resolveIdentity(token, epoch, background = false) {
  if (!background) {
    $("#appRoot").hidden = true;
    $("#authRoot").hidden = false;
    $("#authForm").hidden = true;
    $("#authRetry").hidden = true;
    $("#authMessage").textContent = "Finding your space…";
  }
  try {
    const result = await authRequest("/api/love-loop/me", { headers: { Authorization: "Bearer " + token } });
    if (epoch !== auth.epoch) return;
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401) {
        auth.token = null;
        rememberToken(null);
      } else {
        auth.token = token;
        rememberToken(token);
      }
      lockExperience(authMessage(result.status, "identity"), result.status !== 401);
      return;
    }
    const canonicalId = result.data?.identity?.canonical_id;
    if (typeof canonicalId !== "string" || !canonicalId.trim()) {
      auth.token = token;
      rememberToken(token);
      lockExperience("We couldn't confirm your account. Please try again.", true);
      return;
    }
    auth.token = token;
    auth.identity = { canonicalId };
    model.passenger = safePassenger(result.data?.passenger);
    auth.phase = "ready";
    rememberToken(token);
    $("#authRoot").hidden = true;
    $("#appRoot").hidden = false;
    $("#authPassword").value = "";
    render();
    connectContract();
  } catch {
    if (epoch !== auth.epoch) return;
    auth.token = token;
    rememberToken(token);
    lockExperience(authMessage(0, "identity"), true);
  }
}
async function validateStoredSession(token, epoch) {
  $("#appRoot").hidden = true;
  $("#authRoot").hidden = false;
  $("#authForm").hidden = true;
  $("#authRetry").hidden = true;
  $("#authMessage").textContent = "Finding your space…";
  try {
    const result = await authRequest("/api/love-loop/auth/me", { headers: { Authorization: "Bearer " + token } });
    if (epoch !== auth.epoch) return;
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401) {
        auth.token = null;
        auth.needsAuthValidation = false;
        clearStoredToken();
      } else {
        auth.token = token;
        rememberToken(token);
      }
      lockExperience(authMessage(result.status, "session"), result.status !== 401);
      return;
    }
    auth.needsAuthValidation = false;
    await resolveIdentity(token, epoch);
  } catch {
    if (epoch !== auth.epoch) return;
    auth.token = token;
    rememberToken(token);
    lockExperience(authMessage(0, "session"), true);
  }
}
async function beginAuth() {
  const saved = savedSession();
  if (!saved) {
    lockExperience("Sign in to continue.");
    return;
  }
  auth.persistence = saved.persistence;
  $("#rememberMe").checked = saved.persistence === "persistent";
  auth.token = saved.token;
  auth.needsAuthValidation = true;
  await validateStoredSession(saved.token, ++auth.epoch);
}
async function signIn(event) {
  event.preventDefault();
  const button = $("#authForm button[type=submit]");
  if (button.disabled) return;
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  auth.persistence = $("#rememberMe").checked ? "persistent" : "session";
  auth.token = null;
  auth.needsAuthValidation = false;
  clearStoredToken();
  button.disabled = true;
  $("#authRetry").hidden = true;
  $("#authMessage").textContent = "Opening your space…";
  const epoch = ++auth.epoch;
  try {
    const result = await authRequest("/api/love-loop/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (epoch !== auth.epoch) return;
    $("#authPassword").value = "";
    if (result.status < 200 || result.status >= 300) {
      lockExperience(authMessage(result.status, "login"));
      return;
    }
    const token = result.data?.access_token || result.data?.token || result.data?.bearer_token;
    if (typeof token !== "string" || !token.trim()) {
      lockExperience("We couldn't complete sign-in. Please try again.");
      return;
    }
    await resolveIdentity(token, epoch);
  } catch {
    if (epoch !== auth.epoch) return;
    $("#authPassword").value = "";
    lockExperience(authMessage(0, "login"));
  }
}
function signOut() {
  ++auth.epoch;
  auth.token = null;
  auth.identity = null;
  model.passenger = null;
  auth.needsAuthValidation = false;
  rememberToken(null);
  if (model.overlay) closeSheet();
  lockExperience("You’ve signed out.");
  $("#authEmail").focus();
}

function isContract(value) {
  return value && value.schema_version === "love-loop.experience.v1" &&
    ["modes", "for_me_states", "between_us_states"].every(key =>
      Array.isArray(value[key]) && value[key].every(item => typeof item === "string")) &&
    value.data_rules && ["current_state_requires_live_session", "pattern_count_requires_evidence",
      "between_us_requires_pairing", "pressureiq_detail_exposed"].every(key =>
      typeof value.data_rules[key] === "boolean") &&
    value.data_rules.pressureiq_detail_exposed === false;
}

function allowedMode(mode) { return model.contract.modes.includes(mode); }
function allowedState(mode, state) {
  return model.contract[mode === "for_me" ? "for_me_states" : "between_us_states"].includes(state);
}
function setMode(mode) {
  if (allowedMode(mode)) model.simulated.mode = mode;
}
function setState(mode, state) {
  if (allowedState(mode, state)) model.simulated[mode === "for_me" ? "personal" : "shared"] = state;
}
function reconcileContract() {
  if (!allowedMode(model.simulated.mode)) {
    model.simulated.mode = allowedMode("for_me") ? "for_me" : model.contract.modes[0];
  }
  if (!allowedState("for_me", model.simulated.personal)) {
    model.simulated.personal = allowedState("for_me", "not_measured") ? "not_measured" :
      model.contract.for_me_states.find(state => views[state]) || "not_measured";
  }
  if (!allowedState("between_us", model.simulated.shared)) {
    model.simulated.shared = allowedState("between_us", "not_connected") ? "not_connected" :
      model.contract.between_us_states.find(state => views[state]) || "not_connected";
  }
}

async function connectContract() {
  try {
    const response = await fetch("/api/love-loop/contract", { cache: "no-store" });
    if (!response.ok) return;
    const contract = await response.json();
    if (!isContract(contract) || !contract.modes.includes("for_me") ||
        !contract.modes.includes("between_us") ||
        !contract.for_me_states.length || !contract.between_us_states.length) return;
    model.contract = contract;
    reconcileContract();
    render();
  } catch {
    // An unavailable contract leaves the local preview usable.
  }
}

const views = {
  not_measured: {
    phase: "IN THIS PREVIEW", title: "A quiet space", description: "There is room to simply be here.",
    caption: "LOCAL PREVIEW", actions: [], insightKicker: "A LITTLE MORE, IF YOU WANT IT",
    insight: "Explore example patterns", insightTarget: "pattern"
  },
  settled: {
    phase: "RIGHT NOW",
    title: "You’re settled",
    description: "There is room to simply be here.",
    caption: "A QUIET MOMENT",
    actions: [["Simulate a shift", "shift", "quiet"]],
    insightKicker: "A LITTLE MORE, IF YOU WANT IT",
    insight: "3 patterns noticed today",
    insightTarget: "pattern"
  },
  rising: {
    phase: "A MOMENT IN MOTION",
    title: "Something is shifting",
    description: "Want a little help?",
    caption: "STAY WITH THIS MOMENT",
    actions: [["Breathe with me", "guide", "primary"], ["Let it pass", "return", "secondary"]],
    insightKicker: "YOU HAVE BEEN HERE BEFORE",
    insight: "This looks familiar",
    insightTarget: "pattern"
  },
  guided_response: {
    phase: "A LITTLE SPACE TO RETURN",
    title: "Breathe with me",
    description: "Find a pace that feels right.",
    caption: "IN · OUT",
    actions: [["I’m ready", "return", "primary"], ["Stay a moment", "stay", "secondary"]],
    insightKicker: "THE MOMENT IS STILL YOURS",
    insight: "No rush to move on",
    insightTarget: "pattern"
  },
  returned: {
    phase: "AFTER THE MOMENT",
    title: "You’ve returned",
    description: "A moment can move through you and leave room for what comes next.",
    caption: "BACK TO THE PRESENT",
    actions: [["Back to now", "reset", "primary"], ["See this moment", "history", "secondary"]],
    insightKicker: "OVER TIME",
    insight: "This looks familiar",
    insightTarget: "pattern"
  },
  connected: {
    phase: "BETWEEN US",
    title: "You’re connected",
    description: "Two systems. One shared moment.",
    caption: "SHARED SPACE · SIMULATED",
    actions: [["Preview a shared moment", "shared", "primary"], ["Invite / Pair", "pair", "secondary"]],
    insightKicker: "CONNECTION ACROSS TIME",
    insight: "Shared moments",
    insightTarget: "shared_history"
  },
  shared_moment: {
    phase: "A SHARED SPACE",
    title: "A shared moment is forming",
    description: "Two presences remain their own, even as they move closer.",
    caption: "SHARED PREVIEW · SIMULATED",
    actions: [["End this moment", "end_shared", "primary"], ["Shared moments", "shared_history", "secondary"]],
    insightKicker: "THE SPACE BETWEEN",
    insight: "See the shared sequence",
    insightTarget: "shared_history"
  },
  not_connected: {
    phase: "BETWEEN US", title: "A shared space", description: "Two systems. One shared moment.",
    caption: "SHARED PREVIEW · SIMULATED", actions: [["Invite / Pair", "pair", "secondary"]],
    insightKicker: "CONNECTION ACROSS TIME", insight: "Shared moments", insightTarget: "shared_history"
  }
};

const $ = (selector) => document.querySelector(selector);
let previousFocus = null;

function activeView() {
  return views[model.simulated.mode === "for_me" ? model.simulated.personal : model.simulated.shared] ||
    views.not_measured;
}

function render() {
  const v = activeView();
  const { mode, personal, shared } = model.simulated;
  const state = mode === "for_me" ? personal : shared;
  document.body.classList.toggle("between-us", mode === "between_us");
  document.body.className = document.body.className.replace(/\bstate-[\w-]+\b/g, "").trim();
  document.body.classList.add("state-" + state);
  $("#eyebrowText").textContent = mode === "for_me" ? "YOUR SPACE" : "A SHARED SPACE";
  $("#phaseLabel").textContent = mode === "between_us" && model.source === "simulation"
    ? v.phase + " · PREVIEW" : v.phase;
  $("#headline").innerHTML = v.title + '<span class="period">.</span>';
  $("#description").textContent = v.description;
  $("#visualCaption").textContent = state === "settled" && model.source === "simulation"
    ? "A QUIET MOMENT · SIMULATED" : v.caption;
  $("#insightKicker").textContent = v.insightKicker;
  const countSupported = model.source === "backend" && !!model.backend.liveSession &&
    !!model.backend.patternEvidence;
  $("#insightTitle").textContent = state === "settled" && !countSupported
    ? "3 example patterns" : v.insight;
  $("#insightButton").dataset.open = v.insightTarget;
  $("#historyButton").dataset.open = mode === "for_me" ? "history" : "shared_history";
  $("#homeButton").setAttribute("aria-current", mode === "for_me" ? "page" : "false");
  $("#connectButton").setAttribute("aria-current", mode === "between_us" ? "page" : "false");
  $("#simNotice").textContent = "Local simulation · No sensor or pairing data";
  renderPassenger();
  document.querySelectorAll(".mode-button").forEach(button => {
    const selected = button.dataset.mode === mode;
    button.disabled = !allowedMode(button.dataset.mode);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const actions = $("#actions");
  actions.replaceChildren();
  v.actions.forEach(([label, action, kind]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    button.className = kind + "-action";
    actions.appendChild(button);
  });
}

const sheets = {
  pattern: {
    kicker: "PATTERN INSIGHT",
    html: '<h2 class="sheet-title" id="sheetTitle">This looks familiar<span class="period">.</span></h2>' +
      '<p class="sheet-lede">You’ve returned from moments like this before.</p>' +
      '<div class="sequence" aria-label="Example moment sequence"><span>Settled</span><span>Rising</span><span>Response</span><span>Return</span></div>' +
      '<p class="sheet-lede">Across time, small moments can start to tell a story. You can notice the shape without needing to understand every signal beneath it.</p>' +
      '<p class="sheet-small">Illustrative pattern only. This prototype uses local examples, not measured observations or health conclusions.</p>'
  },
  history: {
    kicker: "MOMENT HISTORY",
    html: '<h2 class="sheet-title" id="sheetTitle">Moments over time<span class="period">.</span></h2>' +
      '<p class="sheet-lede">Each moment has a beginning, a change, and a way through.</p>' +
      '<div class="sequence" aria-label="Moment sequence"><span>Settled</span><span>Rising</span><span>Response</span><span>Return</span></div>' +
      '<ul class="moment-list"><li><span>A moment of return<small>Illustrative moment · Today</small></span><em>Returned</em></li>' +
      '<li><span>A quieter stretch<small>Illustrative moment · Earlier</small></span><em>Settled</em></li></ul>' +
      '<p class="sheet-small">These moments are sample content generated locally for this prototype.</p>'
  },
  shared_history: {
    kicker: "SHARED MOMENTS",
    html: '<h2 class="sheet-title" id="sheetTitle">The space between<span class="period">.</span></h2>' +
      '<p class="sheet-lede">Two independent traces can approach, separate, and meet again.</p>' +
      '<div class="sequence" aria-label="Example shared sequence"><span>Separate</span><span>Closer</span><span>Shared moment</span><span>Separate</span></div>' +
      '<ul class="moment-list"><li><span>A shared moment<small>Simulated example · This preview</small></span><em>Together</em></li></ul>' +
      '<p class="sheet-small">All paired behavior shown here is simulated. No other person or device is connected, and the animation does not infer influence or synchrony.</p>'
  },
  pair: {
    kicker: "INVITE / PAIR",
    html: '<h2 class="sheet-title" id="sheetTitle">Make room for someone<span class="period">.</span></h2>' +
      '<p class="sheet-lede">In a future connected experience, an invitation would let two people enter a shared space while keeping each person’s own trace.</p>' +
      '<p class="sheet-small">Pairing is a prototype preview. No invitation is sent and no person or device is connected.</p>' +
      '<button class="primary-action sheet-button" type="button" data-action="shared">Preview a shared moment</button>'
  }
};

function openSheet(name) {
  const content = sheets[name];
  if (!content) return;
  previousFocus = document.activeElement;
  model.overlay = name;
  $("#sheetKicker").textContent = content.kicker;
  $("#sheetContent").innerHTML = content.html;
  $("#overlay").hidden = false;
  document.body.style.overflow = "hidden";
  $(".detail-sheet").focus();
}

function closeSheet() {
  model.overlay = null;
  $("#overlay").hidden = true;
  document.body.style.overflow = "";
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
}

function act(action) {
  switch (action) {
    case "home": setMode("for_me"); setState("for_me", "settled"); break;
    case "connect": setMode("between_us"); break;
    case "shift": setState("for_me", "rising"); break;
    case "guide": setState("for_me", "guided_response"); break;
    case "return": setState("for_me", "returned"); break;
    case "reset": setState("for_me", "settled"); break;
    case "shared": setState("between_us", "shared_moment"); closeSheet(); break;
    case "end_shared": setState("between_us", "connected"); break;
    case "history": case "pattern": case "shared_history": case "pair": openSheet(action); return;
    case "stay": return;
  }
  render();
}

document.addEventListener("click", (event) => {
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) { setMode(modeButton.dataset.mode); if (model.overlay) closeSheet(); render(); return; }
  if (event.target.closest("[data-close-overlay]")) { closeSheet(); return; }
  const openButton = event.target.closest("[data-open]");
  if (openButton) { openSheet(openButton.dataset.open); return; }
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) act(actionButton.dataset.action);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && model.overlay) closeSheet();
  if (event.key === "Tab" && model.overlay) {
    const focusable = [...document.querySelectorAll("#overlay button")];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === document.querySelector(".detail-sheet"))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
// GitHub Pages only: simulated standby contract, not a real Passenger backend response.
auth.phase = "ready";
model.passenger = { standby: true };
render();

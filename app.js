/* RHLab UI: task cards, two terminals (server/client), buttons, mock exam. Plain JS. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PROGRESS_KEY = 'rhlab.progress.v1';
  const MOCK_MINUTES = 60;
  const MOCK_TASKS = 8;
  const REBOOT_LINES = [
    'Stopping services...',
    'Reached target Reboot',
    'Mounting /data...',
    'Started nfs-server.service',
    'Started autofs.service',
  ];

  // ---------------------------------------------------------------- progress (per browser)
  let progress = { checks: {}, mock: null };
  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) progress = Object.assign({ checks: {}, mock: null }, JSON.parse(raw));
    } catch (e) { /* ignore corrupt progress */ }
  }
  function saveProgress() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (e) { /* private mode */ }
  }

  // ---------------------------------------------------------------- DOM helpers
  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
    }
    for (const c of children || []) n.append(c);
    return n;
  }

  function status(msg) { $('#status').textContent = msg; }

  // ---------------------------------------------------------------- terminals
  const terms = {};

  function makeTerminal(hostName) {
    const root = $('#term-' + hostName);
    const out = el('pre', { class: 'out' });
    const prompt = el('span', { class: 'prompt' });
    const input = el('input', { class: 'in', autocomplete: 'off', spellcheck: 'false', 'aria-label': hostName + ' command' });
    root.append(out, el('div', { class: 'line' }, [prompt, input]));
    const term = {
      host: hostName,
      root: root,
      out: out,
      prompt: prompt,
      input: input,
      session: { user: 'root', cwd: '/root', lastStatus: 0 },
      history: [],
      hIdx: 0,
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runLine(term, input.value); input.value = ''; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); histStep(term, -1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); histStep(term, 1); }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); out.textContent = ''; }
    });
    root.addEventListener('click', () => input.focus());
    terms[hostName] = term;
    renderPrompt(term);
    return term;
  }

  function renderPrompt(term) {
    const h = Sim.lab.host(term.host);
    const short = (h && h.hostname.split('.')[0]) || term.host;
    const cwd = term.session.cwd === '/root' ? '~' : term.session.cwd;
    const sigil = term.session.user === 'root' ? '#' : '$';
    term.prompt.textContent = '[' + term.session.user + '@' + short + ' ' + cwd + ']' + sigil + ' ';
  }

  function append(term, text, cls) {
    if (!text) return;
    const span = el('span', { class: cls || '' });
    span.textContent = text;
    term.out.append(span);
    term.out.scrollTop = term.out.scrollHeight;
  }

  function histStep(term, dir) {
    if (!term.history.length) return;
    term.hIdx = Math.min(term.history.length, Math.max(0, term.hIdx + dir));
    term.input.value = term.hIdx === term.history.length ? '' : term.history[term.hIdx];
  }

  function runLine(term, line) {
    renderPrompt(term);
    append(term, term.prompt.textContent + line + '\n');
    if (line.trim()) { term.history.push(line); }
    term.hIdx = term.history.length;
    if (!line.trim()) return;
    const r = Sim.exec(term.host, line, term.session);
    if (r.out) append(term, r.out);
    if (r.err) append(term, r.err, 'err');
    Sim.save();
    renderPrompt(term);
  }

  function allTerms(fn) { Object.values(terms).forEach(fn); }

  // ---------------------------------------------------------------- tasks
  function taskById(id) { return LAB_TASKS.find(t => t.id === id); }

  function visibleTasks() {
    if (progress.mock && progress.mock.ids && !progress.mock.finished) {
      return LAB_TASKS.filter(t => progress.mock.ids.includes(t.id));
    }
    return LAB_TASKS;
  }

  function runChecks(task) {
    const results = task.checks.map(c => {
      let r;
      try { r = c.run(Sim.lab); }
      catch (e) { r = { pass: false, reason: 'error: ' + e.message }; }
      return { id: c.id, desc: c.desc, pass: !!r.pass, reason: r.reason || '' };
    });
    progress.checks[task.id] = results;
    return results;
  }

  function cardState(task) {
    const r = progress.checks[task.id];
    if (!r) return '';
    return r.every(x => x.pass) ? 'pass' : 'fail';
  }

  function badgeFor(task) {
    const r = progress.checks[task.id];
    if (!r) return el('span', { class: 'badge', text: 'not checked' });
    const passed = r.filter(x => x.pass).length;
    if (passed === r.length) return el('span', { class: 'badge pass', text: 'PASS ' + passed + '/' + r.length });
    return el('span', { class: 'badge fail', text: 'FAIL ' + passed + '/' + r.length });
  }

  function resultsBlock(task) {
    const r = progress.checks[task.id];
    const box = el('div', { class: 'results' });
    if (!r) return box;
    for (const x of r) {
      box.append(el('div', { class: x.pass ? 'pass' : 'fail', text: x.desc }));
      box.append(el('div', { class: 'reason', text: x.reason }));
    }
    return box;
  }

  function progressBar(tasks) {
    const grid = el('div', { class: 'progress', 'aria-hidden': 'true' });
    let passedTasks = 0;
    for (const t of LAB_TASKS) {
      const state = cardState(t);
      if (state === 'pass') passedTasks++;
      const cls = state === 'pass' ? 'on' : state === 'fail' ? 'bad' : '';
      grid.append(el('span', { class: cls }));
    }
    const count = el('span', { class: 'count', text: passedTasks + ' of ' + LAB_TASKS.length + ' passed' });
    const top = el('div', { class: 'row-top' }, [el('span', { class: 'title', text: 'Tasks' }), count]);
    return el('div', { class: 'list-head' }, [top, grid]);
  }

  function renderTasks() {
    const box = $('#tasks');
    box.innerHTML = '';
    const mock = progress.mock && !progress.mock.finished ? progress.mock : null;
    if (mock) {
      box.append(el('div', { class: 'mockbar' }, [
        el('span', { text: 'Mock exam · ' + mock.ids.length + ' of ' + LAB_TASKS.length + ' tasks' }),
        el('span', { class: 'note', text: 'Hints and solutions are hidden' }),
      ]));
    } else if (progress.mock && progress.mock.finished) {
      box.append(el('div', { class: 'mockbar' }, [
        el('span', { text: 'Last mock exam' }),
        el('span', { class: 'note', text: progress.mock.score }),
      ]));
    }
    box.append(progressBar());

    for (const task of visibleTasks()) {
      const needs = task.prereqs.length
        ? el('span', { class: 'chip', text: 'needs ' + task.prereqs.map(id => String(taskById(id).num).padStart(2, '0')).join(', ') })
        : el('span', { class: 'chip none', text: 'no prerequisites' });
      const topicClass = 't-' + task.topic.toLowerCase();
      const hostClass = task.host === 'client' ? ' client' : '';
      const cls = 'card ' + cardState(task);
      const body = el('div', { class: 'body' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'tag ' + topicClass, text: task.topic }),
          el('span', { class: 'hostchip' + hostClass, text: task.host }),
          needs,
          el('span', { class: 'spacer' }),
          badgeFor(task),
        ]),
        el('h3', { text: task.title }),
        el('div', { class: 'scenario', text: task.scenario }),
      ]);
      if (!mock) {
        body.append(
          el('details', null, [el('summary', { text: 'Hint' }), el('p', { text: task.hint })]),
          el('details', null, [
            el('summary', { text: 'Solution' }),
            el('pre', { class: 'sol', text: task.solution.join('\n') }),
          ]),
        );
      }
      const checkBtn = el('button', {
        class: 'btn', text: 'Check',
        onclick: () => { runChecks(task); saveProgress(); renderTasks(); },
      });
      body.append(el('div', { class: 'actions' }, [checkBtn]), resultsBlock(task));
      const card = el('div', { class: cls, id: 'task-' + task.id }, [
        el('div', { class: 'num', text: String(task.num).padStart(2, '0') }),
        body,
      ]);
      box.append(card);
    }
    saveProgress();
  }

  // ---------------------------------------------------------------- check all / reboot / reset
  function checkAll(label) {
    const tasks = visibleTasks();
    let passCount = 0;
    let checkCount = 0;
    for (const t of tasks) {
      const r = runChecks(t);
      passCount += r.filter(x => x.pass).length;
      checkCount += r.length;
    }
    saveProgress();
    renderTasks();
    const msg = (label || 'Check all') + ': ' + passCount + '/' + checkCount + ' checks PASS';
    status(msg);
    return { pass: passCount, total: checkCount };
  }

  // Visual boot log over the terminal panel. The simulated reboot itself is instant;
  // the overlay only plays while checks run and never blocks typing after it closes.
  let bootTimer = null;
  function showBootOverlay() {
    const box = $('#boot');
    const lines = box.querySelector('.boot-lines');
    lines.innerHTML = '';
    box.classList.remove('hidden');
    REBOOT_LINES.forEach((text, i) => {
      setTimeout(() => {
        lines.append(el('div', { class: 'boot-line' }, [el('span', { class: 'ok', text: '[  OK  ]' }), el('span', { text: text })]));
      }, i * 200);
    });
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => box.classList.add('hidden'), REBOOT_LINES.length * 200 + 400);
  }

  function reboot() {
    allTerms(t => append(t, '\n[ system is going down for reboot (simulated) ]\n\n', 'err'));
    Sim.simulateReboot();
    allTerms(t => { t.session = { user: 'root', cwd: '/root', lastStatus: 0 }; renderPrompt(t); });
    showBootOverlay();
    checkAll('After simulated reboot');
    allTerms(t => append(t, '[ boot complete - shell re-opened ]\n\n'));
  }

  function resetLab() {
    if (!confirm('Destroy and rebuild the lab? All changes and check results are lost.')) return;
    Sim.resetLab();
    progress = { checks: {}, mock: null };
    saveProgress();
    stopTimer();
    allTerms(t => { t.out.textContent = ''; t.session = { user: 'root', cwd: '/root', lastStatus: 0 }; renderPrompt(t); });
    allTerms(t => append(t, 'Lab reset. Fresh virtual disks, empty configs.\n\n'));
    renderTasks();
    status('Lab reset.');
  }

  // ---------------------------------------------------------------- mock exam
  let timerId = null;

  function pickMockTasks() {
    // Random order; add a task together with its unchosen prerequisites, never exceeding 8.
    const ids = [];
    const order = LAB_TASKS.map(t => t.id).sort(() => Math.random() - 0.5);
    const closure = (id, acc) => {
      if (acc.includes(id)) return acc;
      for (const p of taskById(id).prereqs) closure(p, acc);
      if (!acc.includes(id)) acc.push(id);
      return acc;
    };
    for (const id of order) {
      if (ids.length >= MOCK_TASKS) break;
      const add = closure(id, []).filter(x => !ids.includes(x));
      if (ids.length + add.length <= MOCK_TASKS) ids.push(...add);
    }
    return ids;
  }

  function startMock() {
    if (progress.mock && !progress.mock.finished) { alert('A mock exam is already running.'); return; }
    if (!confirm('Start a mock exam? The lab is reset, ' + MOCK_TASKS + ' random tasks are chosen, and the timer runs for ' + MOCK_MINUTES + ' minutes.')) return;
    Sim.resetLab();
    progress = {
      checks: {},
      mock: { ids: pickMockTasks(), endsAt: Date.now() + MOCK_MINUTES * 60000, finished: false, score: null },
    };
    saveProgress();
    allTerms(t => { t.out.textContent = ''; t.session = { user: 'root', cwd: '/root', lastStatus: 0 }; renderPrompt(t); });
    allTerms(t => append(t, 'Mock exam started. Good luck.\n\n'));
    startTimer();
    renderTasks();
  }

  function startTimer() {
    stopTimer();
    $('#mock-timer').classList.remove('hidden');
    $('#btn-end').classList.remove('hidden');
    timerId = setInterval(tickTimer, 1000);
    tickTimer();
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    $('#mock-timer').classList.add('hidden');
    $('#btn-end').classList.add('hidden');
  }

  function tickTimer() {
    const m = progress.mock;
    if (!m || m.finished) { stopTimer(); return; }
    const left = Math.max(0, m.endsAt - Date.now());
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    const chip = $('#mock-timer');
    chip.textContent = mins + ':' + String(secs).padStart(2, '0');
    chip.classList.toggle('amber', left < 10 * 60000);
    if (left === 0) finishMock('time is up');
  }

  function finishMock(reason) {
    const m = progress.mock;
    if (!m || m.finished) return;
    stopTimer();
    allTerms(t => append(t, '\n[ exam ended (' + reason + '): simulating reboot before grading ]\n'));
    Sim.simulateReboot();
    showBootOverlay();
    const graded = checkAll('Grading after reboot');
    m.finished = true;
    m.score = graded.pass + '/' + graded.total + ' checks passed after reboot';
    saveProgress();
    renderTasks();
    allTerms(t => append(t, '[ graded ] ' + m.score + '\n'));
    status('Mock exam graded: ' + m.score);
  }

  // ---------------------------------------------------------------- wiring
  function selectHost(name) {
    document.querySelectorAll('.tab[data-host]').forEach(b => b.classList.toggle('active', b.dataset.host === name));
    ['server', 'client'].forEach(h => $('#term-' + h).classList.toggle('hidden', h !== name));
    terms[name].input.focus();
  }

  function init() {
    Sim.bootIfNeeded();
    loadProgress();
    makeTerminal('server');
    makeTerminal('client');
    allTerms(t => append(t, 'RHLab shell. Type "help" for the command list.\nYou are root on ' + Sim.lab.host(t.host).hostname + '.\n\n'));

    document.querySelectorAll('.tab[data-host]').forEach(b => b.addEventListener('click', () => selectHost(b.dataset.host)));
    $('#btn-check-all').addEventListener('click', () => checkAll('Check all'));
    $('#btn-reboot').addEventListener('click', reboot);
    $('#btn-reset').addEventListener('click', resetLab);
    $('#btn-mock').addEventListener('click', startMock);
    $('#btn-end').addEventListener('click', () => { if (confirm('End the exam now and grade it?')) finishMock('ended early'); });

    if (progress.mock && !progress.mock.finished) {
      if (progress.mock.endsAt <= Date.now()) finishMock('time is up');
      else startTimer();
    }
    renderTasks();
    selectHost('server');
    status('Ready. Use the terminals on the right; click Check on a task when you think it is done.');
  }

  init();
})();

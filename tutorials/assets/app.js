/* ============================================================
   StarlingAI Tutorial Site — app.js
   Handles: copy buttons, tabs, progress tracking, nav, sidebar
   ============================================================ */

(function () {
  'use strict';

  /* ── Helpers ──────────────────────────────────────────────── */
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  /* ── Storage key helpers ──────────────────────────────────── */
  const STORE_KEY = 'gs-tutorials-progress';

  function getProgress() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveProgress(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch { /* ignore */ }
  }

  function markStepDone(pageKey, stepId, done = true) {
    const data = getProgress();
    if (!data[pageKey]) data[pageKey] = {};
    data[pageKey][stepId] = done;
    saveProgress(data);
  }

  function isStepDone(pageKey, stepId) {
    const data = getProgress();
    return !!(data[pageKey] && data[pageKey][stepId]);
  }

  /* ── Copy-to-clipboard ────────────────────────────────────── */
  function initCopyButtons() {
    $$('.code-block').forEach(block => {
      const btn = block.querySelector('.copy-btn');
      const pre = block.querySelector('pre');
      if (!btn || !pre) return;

      btn.addEventListener('click', async () => {
        const text = pre.textContent.trim();
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        } catch {
          // Fallback for older browsers / file:// protocol
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          } catch { /* nothing */ }
          document.body.removeChild(ta);
        }
      });
    });
  }

  /* ── Tab groups ───────────────────────────────────────────── */
  function initTabs() {
    $$('.tab-group').forEach(group => {
      const buttons = $$('.tab-btn', group);
      const panels  = $$('.tab-panel', group);

      buttons.forEach(btn => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.tab;
          buttons.forEach(b => b.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          const panel = group.querySelector(`.tab-panel[data-tab="${target}"]`);
          if (panel) panel.classList.add('active');

          // Remember tab choice per group id
          if (group.id) {
            try { localStorage.setItem('gs-tab-' + group.id, target); }
            catch { /* */ }
          }
        });
      });

      // Restore saved tab
      if (group.id) {
        try {
          const saved = localStorage.getItem('gs-tab-' + group.id);
          if (saved) {
            const btn = group.querySelector(`.tab-btn[data-tab="${saved}"]`);
            if (btn) btn.click();
            return;
          }
        } catch { /* */ }
      }

      // Default: activate first tab
      if (buttons[0]) buttons[0].click();
    });
  }

  /* ── Progress tracking (wizard steps) ────────────────────── */
  function initProgress() {
    const pageKey = window.location.pathname || window.location.href;

    $$('.step').forEach(step => {
      const stepId = step.dataset.step;
      if (!stepId) return;

      const btn = step.querySelector('.step-mark-btn');
      if (!btn) return;

      // Restore persisted state
      if (isStepDone(pageKey, stepId)) {
        step.classList.add('done');
        btn.textContent = '✓ Done';
      }

      btn.addEventListener('click', () => {
        const nowDone = !step.classList.contains('done');
        step.classList.toggle('done', nowDone);
        btn.textContent = nowDone ? '✓ Done' : 'Mark as done';
        markStepDone(pageKey, stepId, nowDone);
        updateProgressBar(pageKey);
        updateStepDots(pageKey);
      });
    });

    updateProgressBar(pageKey);
    updateStepDots(pageKey);
  }

  function updateProgressBar(pageKey) {
    const bar = $('.progress-fill');
    const label = $('.progress-current');
    if (!bar) return;

    const steps = $$('.step[data-step]');
    if (!steps.length) return;

    const done = steps.filter(s => isStepDone(pageKey, s.dataset.step)).length;
    const pct = Math.round((done / steps.length) * 100);
    bar.style.width = pct + '%';
    if (label) label.textContent = done;
  }

  function updateStepDots(pageKey) {
    $$('.step-dot[data-step]').forEach(dot => {
      const stepId = dot.dataset.step;
      dot.classList.toggle('done', isStepDone(pageKey, stepId));
    });
  }

  /* ── Active nav highlighting ──────────────────────────────── */
  function initActiveNav() {
    const currentPath = window.location.pathname;
    const currentFile = currentPath.split('/').pop() || 'index.html';

    $$('.nav-link').forEach(link => {
      const href = link.getAttribute('href') || '';
      const linkFile = href.split('/').pop() || 'index.html';

      // Exact match or same file name
      if (linkFile === currentFile && linkFile !== '') {
        link.classList.add('active');
      }

      // Also match parent for channels/*
      if (currentPath.includes('/channels/') && href.includes('/channels/')) {
        const channelFile = currentPath.split('/').pop();
        const linkChannelFile = href.split('/').pop();
        if (channelFile === linkChannelFile) {
          link.classList.add('active');
        }
      }
    });
  }

  /* ── Collapsible sections ─────────────────────────────────── */
  function initCollapsibles() {
    $$('.collapsible-header').forEach(header => {
      header.addEventListener('click', () => {
        const col = header.closest('.collapsible');
        col.classList.toggle('open');
      });
    });
  }

  /* ── Mobile sidebar ───────────────────────────────────────── */
  function initSidebar() {
    const sidebar  = $('.sidebar');
    const overlay  = $('.sidebar-overlay');
    const hamburger = $('.hamburger');
    if (!sidebar || !hamburger) return;

    function open() {
      sidebar.classList.add('open');
      overlay && overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';
    }

    function close() {
      sidebar.classList.remove('open');
      overlay && overlay.classList.remove('visible');
      document.body.style.overflow = '';
    }

    hamburger.addEventListener('click', () => {
      sidebar.classList.contains('open') ? close() : open();
    });

    overlay && overlay.addEventListener('click', close);

    // Close on nav link click (mobile)
    $$('.nav-link', sidebar).forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth < 769) close();
      });
    });
  }

  /* ── Step dot click scrolls to step ──────────────────────── */
  function initStepDotNav() {
    $$('.step-dot[data-step]').forEach(dot => {
      dot.addEventListener('click', () => {
        const target = document.querySelector(`.step[data-step="${dot.dataset.step}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  /* ── Check list items ─────────────────────────────────────── */
  function initCheckList() {
    $$('.check-list li[data-check]').forEach(item => {
      const pageKey = window.location.pathname || window.location.href;
      const checkKey = 'chk-' + item.dataset.check;

      // Restore
      if (isStepDone(pageKey, checkKey)) {
        item.classList.add('checked');
        const icon = item.querySelector('.check-icon');
        if (icon) icon.textContent = '✓';
      }

      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        const nowChecked = !item.classList.contains('checked');
        item.classList.toggle('checked', nowChecked);
        const icon = item.querySelector('.check-icon');
        if (icon) icon.textContent = nowChecked ? '✓' : '';
        markStepDone(pageKey, checkKey, nowChecked);
      });
    });
  }

  /* ── Init all ─────────────────────────────────────────────── */
  function init() {
    initCopyButtons();
    initTabs();
    initProgress();
    initActiveNav();
    initCollapsibles();
    initSidebar();
    initStepDotNav();
    initCheckList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

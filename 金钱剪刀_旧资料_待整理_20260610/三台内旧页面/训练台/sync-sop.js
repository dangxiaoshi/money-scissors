const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_PATH = path.join(
  os.homedir(),
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/dangxiaoshi/项目/金钱剪刀/剪辑营/新版课程提纲.md'
);
const OUTPUT_PATH = path.join(__dirname, 'sop.html');

const INTRO = [
  '# 播客剪辑营 新版课程提纲',
  '',
  '> 工具操作由金钱剪刀产品承载，本课程只讲思维、心态和方法论。',
  '> 所有原文保留口语感，工具名统一替换为金钱剪刀。',
  '',
  '---'
].join('\n');

function parseCourse(markdown) {
  const lines = markdown.split(/\r?\n/);
  let opening = null;
  const modules = [];
  let currentModule = null;
  let currentLecture = null;

  function pushLecture() {
    if (currentLecture && currentModule) {
      currentLecture.content = currentLecture.content.join('\n').trim();
      currentModule.lectures.push(currentLecture);
    }
    currentLecture = null;
  }

  for (const line of lines) {
    const modMatch = line.match(/^##\s+(.+)/);
    const lectureMatch = line.match(/^###\s+(.+)/);

    if (modMatch) {
      pushLecture();
      const title = modMatch[1].trim();
      if (title === '开营仪式') {
        opening = { title, content: [] };
        currentModule = null;
      } else {
        currentModule = {
          id: `mod${modules.length + 1}`,
          num: title.split('：')[0] || `模块${modules.length + 1}`,
          title,
          lectures: []
        };
        modules.push(currentModule);
      }
      continue;
    }

    if (lectureMatch) {
      pushLecture();
      const count = modules.reduce((sum, mod) => sum + mod.lectures.length, 0) + 1;
      currentLecture = {
        id: `lecture${count}`,
        title: lectureMatch[1].trim(),
        content: []
      };
      continue;
    }

    if (currentLecture) currentLecture.content.push(line);
    else if (opening && !currentModule) opening.content.push(line);
  }

  pushLecture();
  if (opening) opening.content = opening.content.join('\n').trim();
  return { opening, modules };
}

function courseToMarkdown(course) {
  const chunks = [INTRO];
  if (course.opening) {
    chunks.push(`## ${course.opening.title || '开营仪式'}\n\n${(course.opening.content || '').trim()}\n\n---`);
  }

  for (const mod of course.modules || []) {
    chunks.push(`## ${mod.title}\n`);
    for (const lecture of mod.lectures || []) {
      chunks.push(`### ${lecture.title}\n\n${(lecture.content || '').trim()}\n\n---`);
    }
  }

  return chunks.join('\n\n').trim() + '\n';
}

function buildSopHtml(course) {
  const totalLectures = (course.modules || []).reduce((sum, mod) => sum + mod.lectures.length, 0);
  const dataScript = [
    `var OPENING = ${JSON.stringify(course.opening || null, null, 2)};`,
    `var MODULES = ${JSON.stringify(course.modules || [], null, 2)};`
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>金钱剪刀 · 剪辑课件</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #f5f0e8; --gold: #c8952a; --gold-light: #e8b84b; --gold-pale: #f5e8c0; --gold-gradient: linear-gradient(135deg, #b8821e 0%, #c8952a 50%, #e8b84b 100%); --text-dark: #1a1209; --text-body: #5a4a2a; --text-muted: #9a8a6a; --border: #e8d8b0; --card-bg: #fffcf0; --radius: 16px; }
    body { font-family: 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; background: var(--bg); color: var(--text-dark); -webkit-font-smoothing: antialiased; min-height: 100vh; }
    .top-bar { position: sticky; top: 0; z-index: 100; background: rgba(245, 240, 232, 0.96); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 14px; }
    .back-link { font-size: 13px; color: var(--gold); text-decoration: none; font-weight: 700; flex-shrink: 0; }
    .course-nav, .module-nav { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .course-nav { flex-shrink: 0; padding-right: 8px; border-right: 1px solid var(--border); }
    .course-nav::-webkit-scrollbar, .module-nav::-webkit-scrollbar { display: none; }
    .nav-btn { flex-shrink: 0; font-size: 12px; padding: 4px 10px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 20px; color: var(--text-muted); cursor: pointer; text-decoration: none; font-family: inherit; white-space: nowrap; transition: border-color 0.15s, color 0.15s; }
    .nav-btn:hover, .nav-btn.active { border-color: var(--gold); color: var(--gold); }
    .hero { text-align: center; padding: 60px 24px 36px; max-width: 760px; margin: 0 auto; }
    .hero-badge { display: inline-block; padding: 4px 14px; background: var(--gold-pale); border: 1px solid var(--gold); border-radius: 20px; font-size: 12px; color: var(--gold); font-weight: 700; margin-bottom: 16px; letter-spacing: 0.06em; }
    .hero h1 { font-size: clamp(28px, 6vw, 44px); font-weight: 900; background: var(--gold-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 12px; }
    .hero-sub { font-size: 15px; color: var(--text-muted); line-height: 1.75; max-width: 620px; margin: 0 auto; }
    .content { min-width: 0; padding-bottom: 30px; }
    .chapter { margin-bottom: 44px; scroll-margin-top: 72px; }
    .chapter-head { padding: 20px 0 14px; margin-bottom: 16px; border-bottom: 2px solid var(--gold-pale); }
    .chapter-label { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .chapter-num { font-size: 12px; font-weight: 700; color: var(--gold); background: var(--gold-pale); padding: 3px 10px; border-radius: 4px; }
    .chapter-range { font-size: 12px; color: var(--text-muted); }
    .chapter-title { font-size: 19px; font-weight: 700; color: var(--text-dark); margin-bottom: 3px; }
    .chapter-sub { font-size: 13px; color: var(--text-muted); }
    .lecture-item { margin-bottom: 8px; border-radius: var(--radius); border: 1.5px solid var(--border); background: var(--card-bg); overflow: hidden; transition: border-color 0.2s; }
    .lecture-item[open] { border-color: var(--gold); box-shadow: 0 4px 16px rgba(200, 149, 42, 0.1); }
    .lecture-item summary { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px; cursor: pointer; list-style: none; font-size: 14px; font-weight: 600; color: var(--text-dark); line-height: 1.55; user-select: none; }
    .lecture-item summary::-webkit-details-marker { display: none; }
    .lecture-num { flex-shrink: 0; font-size: 11px; font-weight: 700; color: var(--gold); background: var(--gold-pale); padding: 2px 7px; border-radius: 4px; margin-top: 1px; }
    .lecture-toggle { flex-shrink: 0; margin-left: auto; width: 22px; height: 22px; border-radius: 50%; background: var(--gold-pale); color: var(--gold); font-size: 16px; font-weight: 300; display: flex; align-items: center; justify-content: center; transition: transform 0.2s; margin-top: 0; }
    .lecture-item[open] .lecture-toggle { transform: rotate(45deg); }
    .lecture-body { padding: 16px 18px 18px; border-top: 1px solid var(--border); }
    .lecture-body p, .lecture-body li, .lecture-body blockquote { font-size: 14px; line-height: 1.85; color: var(--text-body); }
    .lecture-body p { margin-top: 12px; }
    .lecture-body p:first-child { margin-top: 0; }
    .lecture-body ul, .lecture-body ol { margin: 10px 0; padding-left: 22px; }
    .lecture-body li { margin-bottom: 3px; }
    .lecture-body strong { color: var(--text-dark); font-weight: 700; }
    .lecture-body blockquote { margin: 12px 0; padding: 12px 14px; background: #fff7df; border-left: 4px solid var(--gold); border-radius: 0 10px 10px 0; }
    .lecture-body hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
    .app-shell { max-width: 1180px; margin: 0 auto; padding: 0 28px 80px; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 28px; align-items: start; }
    .side-nav { position: sticky; top: 58px; max-height: calc(100vh - 76px); overflow: auto; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: rgba(255,252,240,0.86); box-shadow: 0 8px 24px rgba(122,64,8,0.06); }
    .side-label { font-size: 11px; font-weight: 800; color: var(--gold); letter-spacing: 0.08em; margin: 2px 4px 10px; }
    .side-link { display: block; color: var(--text-body); text-decoration: none; font-size: 13px; line-height: 1.45; padding: 7px 8px; border-radius: 8px; }
    .side-link:hover { color: var(--gold); background: #fff7df; }
    .side-link.major { color: var(--text-dark); font-weight: 800; margin-top: 6px; }
    .side-link.child { padding-left: 18px; font-size: 12px; color: var(--text-muted); }
    .side-link.qa-child { padding-left: 18px; color: #8a6030; }
    .qa-panel { border: 1.5px solid var(--border); border-radius: var(--radius); background: var(--card-bg); padding: 18px; box-shadow: 0 6px 18px rgba(122,64,8,0.05); }
    .qa-intro { color: var(--text-body); font-size: 14px; line-height: 1.8; margin-bottom: 14px; }
    .qa-search { position: sticky; top: 58px; z-index: 20; background: rgba(255,252,240,0.96); padding: 0 0 12px; margin-bottom: 8px; }
    .qa-search input { width: 100%; border: 1.5px solid var(--border); border-radius: 10px; background: #fffdf7; color: var(--text-dark); font: inherit; font-size: 14px; padding: 11px 12px; outline: none; }
    .qa-search input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(200,149,42,0.12); }
    .qa-chips { display: flex; gap: 7px; flex-wrap: wrap; margin: 10px 0 4px; }
    .qa-chip { border: 1px solid var(--border); background: #fff7df; color: #8a6030; border-radius: 20px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
    .qa-chip.active { background: var(--gold); border-color: var(--gold); color: #fff; }
    .qa-group { margin-top: 24px; scroll-margin-top: 118px; }
    .qa-group-title { font-size: 17px; font-weight: 900; color: var(--text-dark); margin-bottom: 10px; }
    .qa-card { border: 1px solid var(--border); border-radius: 10px; background: #fffdf7; margin-bottom: 8px; overflow: hidden; }
    .qa-card[open] { border-color: var(--gold); }
    .qa-card summary { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; list-style: none; padding: 13px 14px; color: var(--text-dark); font-weight: 800; font-size: 14px; line-height: 1.55; }
    .qa-card summary::-webkit-details-marker { display: none; }
    .qa-num { color: var(--gold); background: var(--gold-pale); border-radius: 4px; padding: 1px 7px; font-size: 11px; flex-shrink: 0; margin-top: 1px; }
    .qa-answer { border-top: 1px solid var(--border); padding: 14px; }
    .qa-answer p, .qa-answer li, .qa-answer blockquote { font-size: 14px; line-height: 1.85; color: var(--text-body); }
    .qa-answer p { margin-top: 12px; }
    .qa-answer p:first-child { margin-top: 0; }
    .qa-answer ul, .qa-answer ol { margin: 10px 0; padding-left: 22px; }
    .qa-answer li { margin-bottom: 3px; }
    .qa-answer strong { color: var(--text-dark); font-weight: 800; }
    .qa-answer blockquote { margin: 12px 0; padding: 12px 14px; background: #fff7df; border-left: 4px solid var(--gold); border-radius: 0 10px 10px 0; }
    .qa-empty { display: none; padding: 22px; text-align: center; color: var(--text-muted); font-size: 14px; }
    footer { text-align: center; padding: 28px 20px 40px; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border); line-height: 1.8; }
    footer a { color: var(--gold); text-decoration: none; }
    @media (max-width: 900px) { .app-shell { grid-template-columns: 1fr; padding: 0 18px 70px; } .side-nav { position: static; max-height: none; } .side-link.child { display: inline-block; padding-left: 8px; } .qa-search { position: static; } }
    @media (max-width: 700px) { .top-bar { align-items: flex-start; flex-direction: column; gap: 8px; } .course-nav { width: 100%; border-right: 0; padding-right: 0; } .module-nav { display: none; } }
    @media (max-width: 560px) { .hero { padding: 40px 16px 24px; } .app-shell { padding: 0 14px 60px; } }
  </style>
</head>
<body>
<nav class="top-bar">
  <a class="back-link" href="index.html">金钱剪刀</a>
  <div class="course-nav">
    <a class="nav-btn" href="path.html">21天路径</a>
    <a class="nav-btn" href="map.html">闯关地图</a>
    <a class="nav-btn active" href="sop.html">剪辑课件</a>
  </div>
</nav>
<header class="hero">
  <div class="hero-badge">金钱剪刀 · ${totalLectures}讲</div>
  <h1>播客剪辑营课件</h1>
  <p class="hero-sub">按课程、书本式大纲浏览；遇到具体卡点时，直接到剪辑问答急救包搜索。</p>
</header>
<div class="app-shell">
  <aside class="side-nav" id="sideNav"></aside>
  <main class="content" id="content"></main>
</div>
<footer>金钱剪刀播客剪辑营 · 微信：<a href="#">gaoqiantongxue</a>（搞钱同学）</footer>
<script>
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function inline(t) { return esc(t).replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>').replace(/\`(.+?)\`/g, '<code>$1</code>'); }
function md(raw) {
  var blocks = raw.trim().split(/\\n\\n+/);
  return blocks.map(function(block) {
    var lines = block.split('\\n').filter(function(l) { return l.trim(); });
    if (!lines.length) return '';
    if (lines.every(function(l) { return l.trim() === '---'; })) return '<hr>';
    if (lines.every(function(l) { return l.trim().startsWith('>'); })) return '<blockquote>' + lines.map(function(l) { return inline(l.replace(/^>\\s?/, '')); }).join('<br>') + '</blockquote>';
    var parts = [], ul = [], ol = [], quote = [], txt = [];
    function flushUl() { if (ul.length) { parts.push('<ul>' + ul.join('') + '</ul>'); ul = []; } }
    function flushOl() { if (ol.length) { parts.push('<ol>' + ol.join('') + '</ol>'); ol = []; } }
    function flushQuote() { if (quote.length) { parts.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = []; } }
    function flushTxt() { if (txt.length) { parts.push('<p>' + inline(txt.join(' ')) + '</p>'); txt = []; } }
    lines.forEach(function(line) {
      if (line.match(/^- /)) { flushOl(); flushQuote(); flushTxt(); ul.push('<li>' + inline(line.slice(2)) + '</li>'); }
      else if (line.match(/^\\d+\\. /)) { flushUl(); flushQuote(); flushTxt(); ol.push('<li>' + inline(line.replace(/^\\d+\\. /, '')) + '</li>'); }
      else if (line.match(/^>\\s?/)) { flushUl(); flushOl(); flushTxt(); quote.push(inline(line.replace(/^>\\s?/, ''))); }
      else if (line.trim() === '---') { flushUl(); flushOl(); flushQuote(); flushTxt(); parts.push('<hr>'); }
      else { flushUl(); flushOl(); flushQuote(); txt.push(line); }
    });
    flushUl(); flushOl(); flushQuote(); flushTxt();
    return parts.join('');
  }).join('\\n');
}
${dataScript}
function cleanModuleTitle(title) { return title.replace(/^(模块|板块).+?：/, ''); }
function lectureNum(title, fallback) { var m = title.match(/第(.+?)讲/); return m ? m[1] : fallback; }
function isQaLecture(lecture) { return lecture && /^附录：播客剪辑常见问题库/.test(lecture.title); }
function parseQa(content) {
  var lines = (content || '').split('\\n');
  var intro = [];
  var groups = [];
  var currentGroup = null;
  var currentQa = null;
  function finishQa() {
    if (currentQa && currentGroup) {
      currentQa.answer = currentQa.answer.join('\\n').trim();
      currentGroup.items.push(currentQa);
    }
    currentQa = null;
  }
  lines.forEach(function(line) {
    var groupMatch = line.match(/^\\*\\*([一二三四五六七八九十]+、.+?)\\*\\*\\s*$/);
    var qaMatch = line.match(/^\\*\\*(Q\\d+：.+?)\\*\\*\\s*$/);
    if (groupMatch) {
      finishQa();
      currentGroup = { id: 'qaGroup' + (groups.length + 1), title: groupMatch[1], items: [] };
      groups.push(currentGroup);
      return;
    }
    if (qaMatch) {
      finishQa();
      if (!currentGroup) {
        currentGroup = { id: 'qaGroup' + (groups.length + 1), title: '常见问题', items: [] };
        groups.push(currentGroup);
      }
      currentQa = { id: 'qa' + groups.length + '-' + (currentGroup.items.length + 1), question: qaMatch[1], answer: [] };
      return;
    }
    if (currentQa) currentQa.answer.push(line);
    else if (!currentGroup) intro.push(line);
  });
  finishQa();
  return { intro: intro.join('\\n').trim(), groups: groups };
}
function renderSideNav() {
  var html = '<div class="side-label">课件大纲</div>';
  if (OPENING) html += '<a class="side-link major" href="#opening">开营仪式</a>';
  MODULES.forEach(function(mod) {
    var normalLectures = mod.lectures.filter(function(lecture) { return !isQaLecture(lecture); });
    var qaLecture = mod.lectures.find(isQaLecture);
    if (normalLectures.length) {
      html += '<a class="side-link major" href="#' + mod.id + '">' + cleanModuleTitle(mod.title) + '</a>';
      normalLectures.forEach(function(lecture) {
        html += '<a class="side-link child" href="#' + lecture.id + '">' + lecture.title.replace(/^第.+?讲：?/, '') + '</a>';
      });
    }
    if (qaLecture) {
      var qa = parseQa(qaLecture.content);
      html += '<a class="side-link major" href="#' + qaLecture.id + '">剪辑问答急救包</a>';
      qa.groups.forEach(function(group) {
        html += '<a class="side-link qa-child" href="#' + group.id + '">' + group.title.replace(/^[一二三四五六七八九十]+、/, '') + '</a>';
      });
    }
  });
  document.getElementById('sideNav').innerHTML = html;
}
function renderQaLecture(lecture) {
  var qa = parseQa(lecture.content);
  var chips = qa.groups.map(function(group, idx) {
    return '<button class="qa-chip' + (idx === 0 ? ' active' : '') + '" type="button" data-target="' + group.id + '">' + group.title.replace(/^[一二三四五六七八九十]+、/, '') + '</button>';
  }).join('');
  var groupsHtml = qa.groups.map(function(group) {
    var cards = group.items.map(function(item) {
      var plain = (item.question + ' ' + item.answer).replace(/[\\n*_>#+-]/g, ' ');
      return '<details class="qa-card" data-qa-search="' + esc(plain) + '"><summary><span class="qa-num">' + item.question.match(/^Q\\d+/)[0] + '</span><span>' + item.question.replace(/^Q\\d+：/, '') + '</span></summary><div class="qa-answer">' + md(item.answer) + '</div></details>';
    }).join('');
    return '<section class="qa-group" id="' + group.id + '"><h3 class="qa-group-title">' + group.title + '</h3>' + cards + '</section>';
  }).join('');
  return '<section class="chapter" id="' + lecture.id + '"><div class="chapter-head"><div class="chapter-label"><span class="chapter-num">问答</span><span class="chapter-range">Searchable FAQ</span></div><h2 class="chapter-title">剪辑问答急救包</h2><p class="chapter-sub">从问题入手，卡在哪里就搜哪里。</p></div><div class="qa-panel"><div class="qa-intro">' + md(qa.intro) + '</div><div class="qa-search"><input id="qaSearch" type="search" placeholder="搜索：降噪、金句、口癖、客户、导出..."><div class="qa-chips">' + chips + '</div></div><div id="qaGroups">' + groupsHtml + '</div><div class="qa-empty" id="qaEmpty">没有找到相关问题，换个关键词试试。</div></div></section>';
}
function renderContent() {
  var openingHtml = '';
  if (OPENING) openingHtml = '<section class="chapter" id="opening"><div class="chapter-head"><div class="chapter-label"><span class="chapter-num">开营</span><span class="chapter-range">Opening</span></div><h2 class="chapter-title">' + OPENING.title + '</h2><p class="chapter-sub">先把这趟学习的目标和心气立起来</p></div><details class="lecture-item" open><summary><span class="lecture-num">00</span><span>开营仪式</span><span class="lecture-toggle">+</span></summary><div class="lecture-body">' + md(OPENING.content) + '</div></details></section>';
  var modulesHtml = MODULES.map(function(mod) {
    var normalLectures = mod.lectures.filter(function(lecture) { return !isQaLecture(lecture); });
    var qaLecture = mod.lectures.find(isQaLecture);
    var sectionHtml = '';
    if (normalLectures.length) {
      var first = normalLectures[0] ? lectureNum(normalLectures[0].title, '') : '';
      var last = normalLectures[normalLectures.length - 1] ? lectureNum(normalLectures[normalLectures.length - 1].title, '') : '';
      var lectureHtml = normalLectures.map(function(lecture, idx) { return '<details class="lecture-item" id="' + lecture.id + '"' + (idx === 0 ? ' open' : '') + '><summary><span class="lecture-num">' + lectureNum(lecture.title, String(idx + 1).padStart(2, '0')) + '</span><span>' + lecture.title + '</span><span class="lecture-toggle">+</span></summary><div class="lecture-body">' + md(lecture.content) + '</div></details>'; }).join('');
      sectionHtml += '<section class="chapter" id="' + mod.id + '"><div class="chapter-head"><div class="chapter-label"><span class="chapter-num">课件</span><span class="chapter-range">第' + first + '讲 - 第' + last + '讲</span></div><h2 class="chapter-title">' + cleanModuleTitle(mod.title) + '</h2><p class="chapter-sub">' + normalLectures.length + '讲</p></div>' + lectureHtml + '</section>';
    }
    if (qaLecture) sectionHtml += renderQaLecture(qaLecture);
    return sectionHtml;
  }).join('');
  document.getElementById('content').innerHTML = openingHtml + modulesHtml;
}
function setupQaSearch() {
  var input = document.getElementById('qaSearch');
  if (!input) return;
  var chips = Array.prototype.slice.call(document.querySelectorAll('.qa-chip'));
  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      chips.forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      document.getElementById(chip.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  input.addEventListener('input', function() {
    var term = input.value.trim().toLowerCase();
    var visibleCount = 0;
    document.querySelectorAll('.qa-card').forEach(function(card) {
      var hit = !term || (card.dataset.qaSearch || '').toLowerCase().indexOf(term) !== -1;
      card.style.display = hit ? '' : 'none';
      if (hit) visibleCount++;
    });
    document.querySelectorAll('.qa-group').forEach(function(group) {
      var hasVisible = Array.prototype.some.call(group.querySelectorAll('.qa-card'), function(card) { return card.style.display !== 'none'; });
      group.style.display = hasVisible ? '' : 'none';
    });
    document.getElementById('qaEmpty').style.display = visibleCount ? 'none' : 'block';
  });
}
renderSideNav();
renderContent();
setupQaSearch();
</script>
</body>
</html>
`;
}

function sync() {
  const markdown = fs.readFileSync(SOURCE_PATH, 'utf8');
  const course = parseCourse(markdown);
  fs.writeFileSync(OUTPUT_PATH, buildSopHtml(course), 'utf8');
  return {
    sourcePath: SOURCE_PATH,
    outputPath: OUTPUT_PATH,
    modules: course.modules.length,
    lectures: course.modules.reduce((sum, mod) => sum + mod.lectures.length, 0)
  };
}

if (require.main === module) {
  console.log(JSON.stringify(sync(), null, 2));
}

module.exports = {
  SOURCE_PATH,
  OUTPUT_PATH,
  parseCourse,
  courseToMarkdown,
  buildSopHtml,
  sync
};

const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  SOURCE_PATH,
  OUTPUT_PATH,
  parseCourse,
  courseToMarkdown,
  buildSopHtml
} = require('./sync-sop');

const PORT = Number(process.env.PORT || 8777);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error('内容太大，先分几次保存。'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readCourse() {
  const markdown = fs.readFileSync(SOURCE_PATH, 'utf8');
  const course = parseCourse(markdown);
  return {
    ...course,
    sourcePath: SOURCE_PATH,
    outputPath: OUTPUT_PATH,
    modules: course.modules.map(mod => ({
      ...mod,
      lectures: mod.lectures.map(lecture => ({ ...lecture }))
    }))
  };
}

function saveCourse(course) {
  const markdown = courseToMarkdown(course);
  fs.writeFileSync(SOURCE_PATH, markdown, 'utf8');
  const fresh = parseCourse(markdown);
  fs.writeFileSync(OUTPUT_PATH, buildSopHtml(fresh), 'utf8');
  return {
    modules: fresh.modules.length,
    lectures: fresh.modules.reduce((sum, mod) => sum + mod.lectures.length, 0),
    sourcePath: SOURCE_PATH,
    outputPath: OUTPUT_PATH
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/editor.html')) {
      send(res, 200, fs.readFileSync(path.join(ROOT, 'editor.html')), 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/course') {
      send(res, 200, JSON.stringify(readCourse()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const payload = JSON.parse(await readBody(req));
      send(res, 200, JSON.stringify(saveCourse(payload)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sop.html') {
      send(res, 200, fs.readFileSync(OUTPUT_PATH), 'text/html; charset=utf-8');
      return;
    }

    send(res, 404, JSON.stringify({ error: '没找到这个页面。' }));
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message || String(err) }));
  }
});

server.listen(PORT, HOST, () => {
  const url = HOST === '0.0.0.0' ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`课件编辑器已启动: ${url}`);
  console.log('这个窗口就是编辑器电源：编辑时不要关，编辑完再关。');
  if (HOST === '0.0.0.0') {
    console.log('当前是 Wi-Fi 分享模式：同一网络里的设备可以访问这台电脑的局域网地址。');
  }
  if (process.argv.includes('--open')) {
    childProcess.exec(`open "${url}"`);
  }
});

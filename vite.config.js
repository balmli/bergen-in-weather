import fs from 'fs';
import path from 'path';

// dev-only helper: lets the page POST screenshots to ./shots for review
const shotSaver = () => ({
  name: 'shot-saver',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      const u = new URL(req.url, 'http://x');
      const name = (u.searchParams.get('name') || 'shot').replace(/[^a-z0-9_.-]/gi, '_');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync('shots', { recursive: true });
        fs.writeFileSync(path.join('shots', name), Buffer.from(b64, 'base64'));
        res.end('ok');
      });
    });
  },
});

export default {
  plugins: [shotSaver()],
  server: {
    proxy: {
      '/met': {
        target: 'https://api.met.no',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/met/, ''),
        headers: { 'User-Agent': 'bergen-3d-sim/0.1 github.com/local bjornar.almli@gmail.com' }
      }
    }
  }
};

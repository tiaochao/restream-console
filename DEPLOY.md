# Deployment

Target domain: `xiaoyan.chat`

## Server requirements

- Ubuntu 22.04+ or Debian 12+
- Docker and Docker Compose
- Nginx
- A DNS `A` record for `xiaoyan.chat` pointing to the server public IP

## First deploy

```bash
git clone <your-github-repo-url> restream-console
cd restream-console
cp .env.example .env
nano .env
docker compose up -d --build
```

Generate a strong session secret:

```bash
openssl rand -hex 32
```

Nginx:

```bash
sudo cp nginx-xiaoyan.chat.conf /etc/nginx/sites-available/xiaoyan.chat
sudo ln -s /etc/nginx/sites-available/xiaoyan.chat /etc/nginx/sites-enabled/xiaoyan.chat
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS:

```bash
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d xiaoyan.chat -d www.xiaoyan.chat
```

## Verification

```bash
npm run check
npm run smoke
curl -fsS https://xiaoyan.chat/healthz
```

After login, verify these flows:

- Create a VPS, test connection, install dependencies.
- Add a stream key, verify it with an online VPS.
- Create a task from a public source URL, start it, inspect logs, stop it.
- Add a source channel, run manual check, enable automatic start.
- Upload or scan media, create a media-loop task.
- Create a second user and confirm they cannot see the first user's VPS, tasks, channels, media, stream keys, logs, or settings.

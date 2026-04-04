# 📸 PhotoStream

Site simples para upload e visualização de imagens em tempo real via celular.

---

## ✅ Funcionalidades

- Login com usuário/senha fixos (sem banco de dados)
- Upload de imagens direto do celular (JPG, PNG, WEBP, GIF)
- Visualização com navegação anterior/próxima
- Atualização automática a cada 3 segundos (polling)
- Interface responsiva, mobile-first
- Limite de 10MB por imagem

---

## 📁 Estrutura de pastas

```
photostream/
├── server.js          ← Servidor Express (backend completo)
├── package.json       ← Dependências
├── .gitignore
├── uploads/           ← Criado automaticamente ao subir o servidor
└── public/
    ├── index.html     ← Interface principal
    ├── style.css      ← Estilos
    └── app.js         ← Lógica frontend
```

---

## 🚀 Como rodar localmente

### Pré-requisitos
- [Node.js](https://nodejs.org/) versão 16 ou superior

### Passo a passo

```bash
# 1. Entre na pasta do projeto
cd photostream

# 2. Instale as dependências
npm install

# 3. Inicie o servidor
npm start
```

O servidor vai iniciar em: **http://localhost:3000**

---

## 🔐 Credenciais padrão

| Campo   | Valor     |
|---------|-----------|
| Usuário | `admin`   |
| Senha   | `fotos123`|

### Alterar credenciais

**Opção 1 — via código** (edite o `server.js`):
```js
const AUTH_USER = 'seu_usuario';
const AUTH_PASS = 'sua_senha';
```

**Opção 2 — via variável de ambiente** (recomendado para produção):
```bash
AUTH_USER=meuuser AUTH_PASS=minhasenha node server.js
```

---

## ☁️ Deploy (colocar online)

### Opção A — Render (gratuito, recomendado)

1. Crie conta em [render.com](https://render.com)
2. Clique em **New → Web Service**
3. Conecte o repositório no GitHub
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables:** `AUTH_USER` e `AUTH_PASS`
5. Clique em **Deploy**

> ⚠️ No Render gratuito, o sistema de arquivos é efêmero — as imagens se perdem ao reiniciar. Para persistência, use um plano pago ou armazene as imagens no Cloudinary/S3.

### Opção B — Railway

1. Crie conta em [railway.app](https://railway.app)
2. **New Project → Deploy from GitHub Repo**
3. Adicione as variáveis `AUTH_USER` e `AUTH_PASS`
4. Deploy automático!

### Opção C — VPS/Servidor próprio

```bash
# Instale Node.js e PM2
npm install -g pm2

# Inicie com PM2 (mantém rodando em background)
pm2 start server.js --name photostream

# Reinicia automaticamente após reboot
pm2 save && pm2 startup
```

---

## 🛠️ Modo desenvolvimento (com hot reload)

```bash
npm run dev
```

---

## 📌 Observações

- As imagens são salvas na pasta `/uploads` do servidor
- A sessão dura 24 horas e é salva no `localStorage` do navegador
- O polling verifica novas imagens a cada 3 segundos
- Aceita até 10MB por arquivo

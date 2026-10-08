const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendActivationEmail({ to, code, planType, service }) {
  const serviceLabel = service === 'minecraft' ? 'Minecraft' : 'Discord';
  const planLabel = planType || 'Standard';

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'VHOST <noreply@vhoste.cloud>',
    to,
    subject: `🎮 Votre code d'activation VHOST — ${serviceLabel}`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#0a0a12;color:#e8e8f0;margin:0;padding:0;">
  <div style="max-width:520px;margin:40px auto;background:#11111e;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
    <div style="background:linear-gradient(135deg,#1e2a5e,#2d1b69);padding:32px;text-align:center;">
      <svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 22L50 78L82 22" stroke="white" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <h1 style="color:white;margin:12px 0 4px;font-size:22px;letter-spacing:0.1em">VHOST</h1>
      <p style="color:rgba(255,255,255,0.6);margin:0;font-size:13px">Hébergement Discord & Minecraft</p>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#e8e8f0;font-size:18px;margin:0 0 16px">Merci pour votre achat ! 🎉</h2>
      <p style="color:rgba(255,255,255,0.6);font-size:14px;line-height:1.6;margin:0 0 24px">
        Votre abonnement <strong style="color:#3d7aed">${planLabel}</strong> pour l'hébergement <strong style="color:#3d7aed">${serviceLabel}</strong> est activé.
        Utilisez le code ci-dessous pour accéder à votre espace sur <a href="https://vhoste.cloud" style="color:#3d7aed">vhoste.cloud</a>.
      </p>
      <div style="background:rgba(61,122,237,0.1);border:1px solid rgba(61,122,237,0.3);border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;">
        <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.1em">Votre code d'activation</p>
        <p style="color:#3d7aed;font-size:28px;font-weight:700;font-family:monospace;letter-spacing:0.15em;margin:0">${code}</p>
      </div>
      <div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:16px;margin:0 0 24px;">
        <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0 0 8px">Comment activer votre service :</p>
        <ol style="color:rgba(255,255,255,0.7);font-size:13px;margin:0;padding-left:20px;line-height:1.8;">
          <li>Rendez-vous sur <a href="https://vhoste.cloud/signup" style="color:#3d7aed">vhoste.cloud/signup</a></li>
          <li>Entrez votre code d'activation</li>
          <li>Configurez votre service</li>
        </ol>
      </div>
      <p style="color:rgba(255,255,255,0.3);font-size:12px;text-align:center;margin:0">
        Besoin d'aide ? Contactez-nous sur Discord ou à <a href="mailto:noreply@vhoste.cloud" style="color:#3d7aed">noreply@vhoste.cloud</a>
      </p>
    </div>
  </div>
</body>
</html>
    `,
  });
}

module.exports = { sendActivationEmail };

const CF_TOKEN = process.env.CF_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_DOMAIN = process.env.CF_DOMAIN || 'vhoste.cloud';
const CF_API = 'https://api.cloudflare.com/client/v4';

function headers() {
  return {
    'Authorization': 'Bearer '+CF_TOKEN,
    'Content-Type': 'application/json',
  };
}

// Creer un enregistrement SRV pour Minecraft
// _minecraft._tcp.slug.vhoste.cloud -> 103.102.135.92:PORT
async function createMinecraftSubdomain(slug, port) {
  if (!CF_TOKEN || !CF_ZONE_ID) throw new Error('Cloudflare non configure.');

  // Verifier que le slug est valide
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) throw new Error('Nom invalide (3-32 caracteres, lettres minuscules, chiffres et tirets).');

  // Verifier si le sous-domaine existe deja
  const check = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records?name=${slug}.${CF_DOMAIN}&type=A`, { headers: headers() });
  const checkData = await check.json();
  if (checkData.result && checkData.result.length > 0) throw new Error('Ce nom est deja pris.');

  // Creer enregistrement A pointant vers le VPS
  const r = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      type: 'A',
      name: slug+'.'+CF_DOMAIN,
      content: '103.102.135.92',
      ttl: 1,
      proxied: false,
      comment: 'VHOST auto - tenant subdomain',
    }),
  });
  const data = await r.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'Erreur Cloudflare.');
  const recordId = data.result.id;

  // Creer enregistrement SRV pour Minecraft Java
  // _minecraft._tcp.slug.vhoste.cloud -> slug.vhoste.cloud:PORT
  const srvRes = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      type: 'SRV',
      name: '_minecraft._tcp.'+slug+'.'+CF_DOMAIN,
      data: {
        service: '_minecraft',
        proto: '_tcp',
        name: slug+'.'+CF_DOMAIN,
        priority: 0,
        weight: 5,
        port: port,
        target: slug+'.'+CF_DOMAIN,
      },
      ttl: 1,
      comment: 'VHOST auto - minecraft SRV',
    }),
  });
  const srvData = await srvRes.json();
  const srvRecordId = srvData.success ? srvData.result.id : null;

  return { recordId, srvRecordId, hostname: slug+'.'+CF_DOMAIN };
}

async function deleteSubdomain(recordId, srvRecordId) {
  if (recordId) {
    await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records/${recordId}`, {
      method: 'DELETE', headers: headers(),
    });
  }
  if (srvRecordId) {
    await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records/${srvRecordId}`, {
      method: 'DELETE', headers: headers(),
    });
  }
}

async function isSlugAvailable(slug) {
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) return false;
  const r = await fetch(`${CF_API}/zones/${CF_ZONE_ID}/dns_records?name=${slug}.${CF_DOMAIN}&type=A`, { headers: headers() });
  const data = await r.json();
  return !data.result || data.result.length === 0;
}

module.exports = { createMinecraftSubdomain, deleteSubdomain, isSlugAvailable };

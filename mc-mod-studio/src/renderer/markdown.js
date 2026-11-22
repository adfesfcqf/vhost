// Mini rendu Markdown (sûr : tout est échappé) pour les réponses de l'IA.
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  }

  function render(md) {
    const out = [];
    const lines = md.split('\n');
    let i = 0;
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        closeList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++;
        out.push(`<div class="codeblock" data-lang="${esc(lang)}"><div class="code-actions"><span>${esc(lang)}</span><button class="copy">Copier</button><button class="insert">Insérer dans le fichier</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { closeList(); out.push(`<h4>${inline(h[2])}</h4>`); i++; continue; }
      const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
      if (li) {
        const type = /\d/.test(li[1]) ? 'ol' : 'ul';
        if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
        out.push(`<li>${inline(li[2])}</li>`);
        i++;
        continue;
      }
      closeList();
      if (line.trim() === '') { i++; continue; }
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    closeList();
    return out.join('');
  }

  window.renderMarkdown = render;
  window.escapeHtml = esc;
})();

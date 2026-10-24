const STATUS_LABEL = {
  non_specificato: 'non specificato', ambiguo: 'ambiguo', da_verificare: 'da verificare',
  confermato: 'confermato', contestato: 'contestato', superato: 'superato',
};

export function reportToMarkdown({ session, segments, items }) {
  const r = session.report;
  const seqOf = new Map(segments.map((s) => [s.id, s.seq]));
  const src = (ids) => ids?.length ? ` _(fonte: ${ids.map((i) => `S${seqOf.get(i) ?? '?'}`).join(', ')})_` : '';
  const line = (i) => `- ${i.content}${i.owner ? ` — resp.: ${i.owner}` : ''}${i.due_text ? ` — scadenza: ${i.due_text}${i.due_date ? ` (${i.due_date})` : ''}` : ''} **[${STATUS_LABEL[i.status]}]**${src(i.source_segment_ids)}`;
  const out = [`# ${session.title}`, '', `Template: ${session.template_id} v${session.template_version} · Stato: ${session.status} · Inizio: ${session.started_at ?? '-'} · Fine: ${session.ended_at ?? '-'}`, ''];
  if (r) {
    out.push('## Sintesi', '', r.summary, '', `_Generata da: ${r.summary_source}. Completezza campi obbligatori: ${Math.round(r.completeness * 100)}%_`, '');
    out.push('## Campi del template', '', ...r.fields.map((f) => `- **${f.label}**: ${f.value ?? '—'} [${STATUS_LABEL[f.status] ?? f.status}]${src(f.source_segment_ids)}`), '');
    const sec = (title, arr) => { if (arr?.length) out.push(`## ${title}`, '', ...arr.map(line), ''); };
    sec('Impegni', r.commitments);
    sec('Decisioni', r.decisions);
    sec('Domande aperte', r.open_questions);
    sec('Rischi', r.risks);
    sec('Da verificare (conferma umana)', r.to_verify);
    sec('In conflitto', r.contested);
    if (r.cross_session?.length) {
      out.push('## Confronto con conversazioni precedenti', '', ...r.cross_session.map((c) => `- **${c.field_key}**: prima «${c.previous.value}» (${c.previous.session_title}) → ora «${c.current.value}» [${STATUS_LABEL[c.current.status]}]`), '');
    }
    if (r.open_points?.length) out.push('## Punti aperti (Gemma)', '', ...r.open_points.map((p) => `- ${p}`), '');
    if (r.audio_gaps?.length) out.push('## Interruzioni audio', '', ...r.audio_gaps.map((g) => `- ${g.channel}: ${g.from ?? '?'} → ${g.to} (${g.gap_ms ?? '?'} ms) ${g.reason ?? ''}`), '');
  } else {
    out.push('_Report post-chiamata non ancora generato._', '');
    out.push('## Elementi estratti', '', ...items.filter((i) => i.status !== 'superato').map(line), '');
  }
  out.push('## Trascrizione', '', ...segments.map((s) => `**S${s.seq} · ${s.speaker}**${s.version > 1 ? ` _(corretto v${s.version})_` : ''}: ${s.text}`), '');
  out.push('---', '_Le dichiarazioni non sono fatti verificati. Gli elementi «da verificare» richiedono conferma umana._');
  return out.join('\n');
}

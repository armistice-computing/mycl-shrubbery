/**
 * The name a new document gets when the person gives none (Eschaton,
 * 2026-11-18): when it was made, in short form, in place of "Untitled".
 * Month.day.year.hour.minute, the hour on a 24-hour clock so a morning and
 * an evening note never share a name: 11.18.26.9.55, 11.18.26.21.05.
 */
export function untitledDocumentTitle(now: Date = new Date()): string {
  const year = String(now.getFullYear() % 100).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  return `${now.getMonth() + 1}.${now.getDate()}.${year}.${now.getHours()}.${minute}`
}

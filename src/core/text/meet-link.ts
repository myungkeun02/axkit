/** Video meeting links worth handing the owner before a meeting (Google Meet, Zoom, Teams). */
const VIDEO_LINK = /https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|[\w.-]*zoom\.us\/j\/\d+[^\s"<>)]*|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>)]+)/i;

/** The first video meeting link in a text, if any. */
export function meetLinkIn(text: string | undefined): string | undefined {
  return text === undefined ? undefined : VIDEO_LINK.exec(text)?.[0];
}

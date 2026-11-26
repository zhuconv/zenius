/* Agent Sidebar's live card, the page's side (AgentSidebarPictureParent.sys.mjs
 * asks). It paints the top of the agent's page, the part the card shows, at
 * the card's size, here in the page's own process, and sends back its raw
 * pixels.
 *
 * Why here and not drawSnapshot: drawSnapshot replays the page's paint in the
 * parent, on its main thread, so a page that is costly to paint (the snapshot layer's
 * turbulence filter took 200-260 ms a picture) stalled the user's whole
 * browser through the card. Painted here, a costly page slows only its own
 * process, and the parent only copies the pixels into the card.
 * drawWindow paints this process's frames only: an iframe from another site
 * (another process) comes out blank in the card.
 */

const HTML = "http://www.w3.org/1999/xhtml";
// The card is at most this many device pixels; anything bigger isn't ours.
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 1024;

export class AgentSidebarPictureChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name !== "AgentSidebarPicture:draw") {
      return null;
    }
    const { width, height } = message.data ?? {};
    const win = this.contentWindow;
    if (
      !win ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_WIDTH ||
      height > MAX_HEIGHT
    ) {
      return null;
    }
    const view = win.innerWidth;
    const tall = win.innerHeight;
    if (!(view > 0 && tall > 0)) {
      return null;
    }
    // The card shows the page as wide as the card: the top `rows` CSS pixels
    // of the viewport are all it shows, so only those are painted.
    const scale = width / view;
    const rows = Math.min(tall, height / scale);
    const canvas = this.document.createElementNS(HTML, "canvas");
    canvas.width = width;
    canvas.height = Math.max(1, Math.min(height, Math.ceil(rows * scale)));
    // A canvas in memory: drawWindow paints into it, and reading it back is
    // a copy, not a trip to the GPU process.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.scale(scale, scale);
    // DRAW_VIEW: the viewport as it is scrolled, fixed elements where they show.
    ctx.drawWindow(win, 0, 0, view, rows, "rgb(255,255,255)", ctx.DRAWWINDOW_DRAW_VIEW);
    // Raw pixels rather than an image file, so the parent decodes nothing
    // this process made: it only copies them into the card.
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: image.width, height: image.height, pixels: new Uint8Array(image.data.buffer) };
  }
}

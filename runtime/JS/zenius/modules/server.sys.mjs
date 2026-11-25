// NDJSON over a Unix domain socket. One JSON object per line in each
// direction; see docs/PROTOCOL.md "Frames".

import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
// The sign-in rules' redaction: it loads with the first frame a client gets,
// not at startup (I4).
ChromeUtils.defineESModuleGetters(lazy, {
  redactText: "chrome://userscripts/content/zenius/content/signin.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

let nextConnectionId = 1;

// How long a connection that ends after its last frames (end()) waits for its
// client to close its side before the socket closes anyway.
const END_GRACE_MS = 5000;

export class RpcServer {
  QueryInterface = ChromeUtils.generateQI(["nsIServerSocketListener"]);
  /** @type {nsIServerSocket|null} */
  #socket = null;
  #connections = new Set();

  /**
   * @param {object} opts
   * @param {string} opts.socketPath
   * @param {(conn: Connection) => object} opts.hello  first frame for a new connection
   * @param {(conn: Connection) => void} [opts.onOpen]  after the hello, before any frame is read
   * @param {(conn: Connection, frame: object) => void} opts.onFrame
   * @param {(conn: Connection) => void} [opts.onClose]
   */
  constructor({ socketPath, hello, onOpen, onFrame, onClose }) {
    this.socketPath = socketPath;
    this.hello = hello;
    this.onOpen = onOpen;
    this.onFrame = onFrame;
    this.onClose = onClose;
  }

  listen() {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(this.socketPath);
    if (file.exists()) {
      // A socket file left by a crashed run. The registry file check in the
      // service decides whether another live instance owns it.
      file.remove(false);
    }
    const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    socket.initWithFilename(file, 0o600, -1);
    socket.asyncListen(this);
    this.#socket = socket;
  }

  close() {
    for (const conn of this.#connections) {
      conn.close();
    }
    this.#socket?.close();
    this.#socket = null;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(this.socketPath);
      if (file.exists()) {
        file.remove(false);
      }
    } catch (e) {
      log("could not remove socket", this.socketPath, e.message);
    }
  }

  get connectionCount() {
    return this.#connections.size;
  }

  get connections() {
    return this.#connections;
  }

  // nsIServerSocketListener
  onSocketAccepted(_server, transport) {
    const conn = new Connection(transport, this);
    this.#connections.add(conn);
    conn.start();
  }

  onStopListening(_server, status) {
    if (status !== Cr.NS_BINDING_ABORTED) {
      log("server stopped listening, status", status);
    }
  }

  _forget(conn) {
    this.#connections.delete(conn);
    this.onClose?.(conn);
  }
}

export class Connection {
  QueryInterface = ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]);
  #transport;
  #server;
  #binIn;
  #out;
  #rawOut;
  #pump;
  /** end()'s grace timer, while it waits for the client to close its side. */
  #ending = null;
  #transportClosed = false;
  #decoder = new TextDecoder();
  /** Pieces of a frame whose newline hasn't arrived yet. */
  #pieces = [];
  closed = false;
  /** Per-connection state that method handlers may keep (event subscriptions). */
  state = {};

  constructor(transport, server) {
    this.id = nextConnectionId++;
    this.#transport = transport;
    this.#server = server;
  }

  start() {
    const input = this.#transport.openInputStream(0, 0, 0);
    // Buffered, non-blocking output into a pipe that never fills (segcount is
    // capped at 4 GB), so a large result can't block the main thread or fail
    // with WOULD_BLOCK.
    this.#rawOut = this.#transport.openOutputStream(0, 65536, 0xffffffff);
    this.#out = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
    this.#out.init(this.#rawOut, "UTF-8");
    this.#binIn = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    this.#binIn.setInputStream(input);
    this.#pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
    this.#pump.init(input, 0, 0, false);
    this.#pump.asyncRead(this);
    this.send(this.#server.hello(this));
    try {
      this.#server.onOpen?.(this);
    } catch (e) {
      Cu.reportError(e);
    }
  }

  /**
   * Every frame a client gets goes out here: results, errors and events.
   * A URL that carries a sign-in's code (content/signin.sys.mjs) is cut at
   * its query in all of them, wherever it sits: a field, a header, a title,
   * a page's text.
   *
   * @param {object} frame
   */
  send(frame) {
    if (this.closed) {
      return false;
    }
    let text;
    try {
      text = JSON.stringify(frame);
    } catch (e) {
      text = JSON.stringify({
        id: frame.id,
        error: { code: "ZEN_INTERNAL", message: `result is not JSON-serializable: ${e.message}` },
      });
    }
    text = lazy.redactText(text);
    try {
      this.#out.writeString(text + "\n");
      this.#out.flush();
      return true;
    } catch (e) {
      log(`conn ${this.id}: write failed, closing`, e.message);
      this.close();
      return false;
    }
  }

  /**
   * Closes the socket at once. Frames sent just before may not reach the
   * client: the socket thread copies the output pipe to the socket on its
   * own, and closing the transport drops what it hasn't copied yet. Use
   * end() after a frame the client must get.
   */
  close() {
    if (this.closed) {
      // An end() whose client closed its side, or whose grace ran out.
      this.#closeTransport();
      return;
    }
    this.closed = true;
    try {
      this.#out?.close();
    } catch {}
    this.#closeTransport();
    this.#server._forget(this);
  }

  /**
   * Closes after the frames already sent, which the client then gets in
   * full: the output pipe is closed, so the socket thread copies what's left
   * in it, and the socket closes once the client closes its side, or
   * END_GRACE_MS later. For the service the connection ends now, as with
   * close(): send() sends nothing more, and frames that arrive meanwhile are
   * read and dropped, never run.
   */
  end() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.#out?.close();
    } catch {}
    this.#ending = lazy.setTimeout(() => this.#closeTransport(), END_GRACE_MS);
    this.#server._forget(this);
  }

  #closeTransport() {
    if (this.#transportClosed) {
      return;
    }
    this.#transportClosed = true;
    if (this.#ending) {
      lazy.clearTimeout(this.#ending);
      this.#ending = null;
    }
    try {
      this.#transport.close(Cr.NS_OK);
    } catch {}
  }

  // nsIStreamListener
  onStartRequest() {}

  onDataAvailable(_request, _stream, _offset, count) {
    const buf = new ArrayBuffer(count);
    this.#binIn.readArrayBuffer(count, buf);
    // Ended (end()): read, so the pump goes on until the client closes, and
    // dropped, since nothing of this connection runs any more.
    if (this.closed) {
      return;
    }
    const text = this.#decoder.decode(new Uint8Array(buf), { stream: true });
    // Requests can be many MiB. Search only the new text and join a frame's
    // pieces once its newline arrives: growing one string and searching it
    // from the start on every chunk is quadratic.
    let start = 0;
    let nl;
    while ((nl = text.indexOf("\n", start)) !== -1) {
      this.#pieces.push(text.slice(start, nl));
      const line = this.#pieces.join("");
      this.#pieces = [];
      start = nl + 1;
      if (line.trim()) {
        this.#onLine(line);
      }
    }
    if (start < text.length) {
      this.#pieces.push(text.slice(start));
    }
  }

  onStopRequest(_request, status) {
    if (status !== Cr.NS_OK && status !== Cr.NS_BASE_STREAM_CLOSED) {
      log(`conn ${this.id}: input stopped with ${ChromeUtils.getXPCOMErrorName(status)}`);
    }
    this.close();
  }

  #onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (e) {
      this.send({ id: null, error: { code: "ZEN_INVALID_ARGUMENT", message: `bad JSON frame: ${e.message}` } });
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      this.send({ id: null, error: { code: "ZEN_INVALID_ARGUMENT", message: "a frame must be a JSON object" } });
      return;
    }
    this.#server.onFrame(this, frame);
  }
}

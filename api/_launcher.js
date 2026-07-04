/**
 * The post-gate launcher screen, shared by /api/subscribe (new signups) and
 * /api/login (returning members). Served ONLY by those endpoints so nothing
 * about the setup (repo, command) exists in the landing page's own HTML.
 *
 * The page's static JS activates it: the LS mark spins with cycling messages
 * (the luigi-os loader, values copied exactly) while the page polls the
 * visitor's own machine for the Luigi web app and opens it when it appears.
 */
const LAUNCHER_HTML = `
        <div class="step" id="launcher">
          <span class="n">Setting up Luigi Codes</span>
          <div class="loader" role="status">
            <span class="sr-only">Loading</span>
            <img src="/brand/luigi-solutions-mark-loader.png" alt="" aria-hidden="true" draggable="false" class="loader-mark">
            <p aria-hidden="true" class="loader-msg-line"><span id="loaderMsg" class="loader-msg">Eating...</span></p>
          </div>
          <p id="launchStatus" class="launch-status">Looking for Luigi Codes on this machine...</p>
          <div class="setup-how">
            <p id="copyNote">New machine? Copy the command below, open Terminal (press Cmd+Space and type Terminal), paste, and press Return.</p>
<pre class="cmd"><code id="getCmd">curl -fsSL https://luigi-codes.vercel.app/get | bash</code><button class="copy-cmd" type="button">Copy</button></pre>
            <p class="fine">That one command does everything: builds Luigi, installs the VS Code extension,
            finds or fetches a model, and starts the web app. This page opens it the moment it's ready.</p>
            <p class="fine">Already installed? Start Luigi anytime: run "Luigi: Open Web App" in VS Code,
            or <code>cd ~/luigi-codes &amp;&amp; npm run web</code> in Terminal. The moment it's up, you're in.</p>
          </div>
          <p class="launch-open"><a class="btn btn-ghost" id="openApp" href="http://localhost:8091/">Open Luigi Codes</a></p>
        </div>`;

module.exports = { LAUNCHER_HTML };

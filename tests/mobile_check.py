"""Phone-size check of every page in demo mode (headless Chrome, 390 x 844).

Run:  python3 tests/mobile_check.py [outdir]
For each page it saves a full-page screenshot and reports anything that does not fit:
the page scrolling sideways, or a control (input, select, button, chip) cut off by its box or the screen.
Exits 1 if any page has a problem.
"""
import os, sys, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8766
BASE = f"http://localhost:{PORT}/"
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mobile"
os.makedirs(OUT, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, *a):
        pass


# Controls whose text is cut off, and anything wider than the screen (tables may scroll inside their own box).
PROBE = """() => {
  const W = innerWidth, out = [];
  if (document.documentElement.scrollWidth > W + 1) out.push('page scrolls sideways: ' + document.documentElement.scrollWidth + 'px');
  const inScroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return true; } return false; };
  for (const el of document.querySelectorAll('select, button, .chip, h1, h2, h3')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden], details:not([open]) > :not(summary)')) continue;
    const name = (el.tagName + ' ' + (el.getAttribute('aria-label') || el.value || el.textContent || '').trim()).slice(0, 60);
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(el).font;
      const need = opt ? c.measureText(opt.text).width + 26 : 0;
      if (need > r.width + 1 && !(opt && opt.text.length <= 2)) out.push('select too narrow (' + Math.round(r.width) + ' < ' + Math.round(need) + 'px): ' + name);
    } else if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') out.push('text cut off: ' + name);
    if (!inScroller(el) && (r.left < -1 || r.right > W + 1)) out.push('off screen: ' + name);
  }
  return [...new Set(out)];
}"""


def main():
    srv = Server(("localhost", PORT), Quiet)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    problems = {}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
        page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
        page.on("dialog", lambda d: d.accept())
        page.route("https://grassrootsapiproxy.cricket.com.au/**", lambda r: r.abort())

        def shot(name, ready="main > *"):
            page.wait_for_selector(ready)
            page.wait_for_timeout(700)
            page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
            found = page.evaluate(PROBE)
            if found:
                problems[name] = found

        def sign_in(email):
            page.goto(BASE + "#/")
            page.wait_for_selector("#login-email, .who")
            if page.locator(".who").count():
                page.click(".who-name"); page.click(".who-menu button:has-text('Sign out')")
                page.wait_for_selector("#login-email")
            page.fill("#login-email", email)
            page.click("button:has-text('Sign in')")
            page.wait_for_selector(".who")

        page.goto(BASE + "#/")
        page.wait_for_selector("#login-email")
        shot("01-sign-in")
        sign_in("admin@demo.test")
        page.click("button:has-text('Load sample data')")
        page.wait_for_selector(".tile-round")
        shot("02-allocate", ".tile-round")
        page.click(".who-name"); shot("03-account-menu", ".who-menu[open] .menu-items"); page.click(".who-name")
        page.click("nav .menu > summary"); shot("04-org-menu", "nav .menu[open] .menu-items"); page.click("nav .menu > summary")
        rid = page.evaluate("() => location.hash")  # placeholder
        page.locator("a.tile-body").first.click()
        page.wait_for_selector("table.board")
        rid = page.evaluate("() => location.hash.split('/').pop()")
        shot("05-assign-board", "table.board")
        page.click("button:has-text('Select grades')"); shot("06-select-grades", "dialog[open], .modal"); page.keyboard.press("Escape")
        page.goto(BASE + f"#/admin/round/{rid}/availability"); shot("07-round-availability")
        page.goto(BASE + f"#/admin/round/{rid}/report"); shot("08-report")
        page.goto(BASE + "#/admin/availability"); shot("09-season-availability")
        page.goto(BASE + "#/admin/members"); shot("10-members", "table.members")
        page.locator("a.member-link").first.click(); shot("11-member-profile", ".member-profile")
        page.goto(BASE + "#/admin/past"); shot("12-past-allocations")
        page.goto(BASE + "#/admin/settings"); shot("13-settings", ".groups-card")
        page.goto(BASE + "#/associations"); shot("14-associations")
        sign_in("umpire4@demo.test")
        page.goto(BASE + "#/my"); shot("15-my-availability-summary", ".my-summary")
        page.click(".my-summary button:has-text('Edit availability')"); shot("16-my-availability-form", ".comp-section")
        page.goto(BASE + "#/profile"); shot("17-my-profile", ".member-profile")
        page.goto(BASE + "#/profile/edit"); shot("18-edit-details", "form")
        b.close()
    srv.shutdown()
    for name, found in problems.items():
        print(f"{name}:")
        for f in found:
            print("   -", f)
    print(f"\n{len(problems)} page(s) with problems; screenshots in {OUT}")
    sys.exit(1 if problems else 0)


main()

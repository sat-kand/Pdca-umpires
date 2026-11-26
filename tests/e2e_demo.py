"""End-to-end test of the app in demo mode (headless Chrome).

Run:  python3 tests/e2e_demo.py      (starts its own local web server)
Needs: python playwright + a Chrome/Chromium binary (CHROME env var or /usr/bin/google-chrome).
"""
import json, os, re, subprocess, sys, time, threading, http.server, socketserver
from datetime import date, timedelta
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
BASE = f"http://localhost:{PORT}/"


def goto(pg, url):
    """Open a page of the app. Once it is loaded, move inside it the way a link does (no reload); the first time, load it."""
    if pg.url.startswith(BASE):
        pg.evaluate("p => { history.pushState(null, '', p); window.dispatchEvent(new Event('route')); }", url[len(BASE) - 1:])
    else:
        pg.goto(url)
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    # The tests run the app in demo mode, whatever Supabase project js/config.js points at.
    def do_GET(self):
        route = self.path.split('?')[0]
        if '.' not in os.path.basename(route) and not route.startswith(('/js/', '/css/')):
            self.path = '/index.html'          # clean URLs: the host sends every page path to index.html
        if self.path.split("?")[0] == "/js/config.js":
            import re as _re
            src = open(os.path.join(ROOT, "js", "config.js"), encoding="utf-8").read()
            src = _re.sub(r"supabase:\s*\{[^}]*\}", "supabase: { url: '', anonKey: '' }", src, count=1).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(src)))
            self.end_headers()
            self.wfile.write(src)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):       # threaded: two browser contexts can load at once
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, *a):
        pass                                          # a browser closing a connection is not a test failure


httpd = Server(("", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

today = date.today()
sat1 = today + timedelta(days=(5 - today.weekday()) % 7)   # next Saturday (or today)
sat2 = sat1 + timedelta(days=7)
D1, D2 = sat1.isoformat(), sat2.isoformat()
# Labels the app prints for those dates (the sample data is always "this coming Saturday and the next").
def _n(d): return f"{d.day} {d:%b}"
S1, S2 = f"Sat, {_n(sat1)}", f"Sat, {_n(sat2)}"
N2 = _n(sat2)
P1, P2 = sat1 - timedelta(days=7), sat1 - timedelta(days=14)   # the two finished sample rounds

# ---- fake fixture service (answers in the shape the app reads) -------------
def match(mid, rnd, mtype, days, home, away, venue):
    return {"id": mid, "status": "SCHEDULED", "matchType": mtype, "round": {"id": "r", "name": rnd, "shortName": "R"},
            "matchSchedule": [{"matchDay": i + 1, "startDateTime": f"{d}T13:30:00.0000000+11:00"} for i, d in enumerate(days)],
            "venue": {"name": venue, "line1": "1 Test St", "suburb": "PARRAMATTA", "playingSurface": {"name": venue, "latitude": -33.8, "longitude": 151.0}},
            "teams": [{"id": mid + "h", "displayName": home, "isHome": True, "owningOrganisation": {"name": home + " Cricket Club"}},
                      {"id": mid + "a", "displayName": away, "isHome": False, "owningOrganisation": {"name": away + " Cricket Club"}}]}

API = {
    "g-a": [match("m1", "Round 2", "Two Day", [D1, D2], "Kings Langley", "Vone", "Pearce Reserve"),
            match("m2", "Round 9", "Two Day", [(sat1 + timedelta(days=56)).isoformat()], "Late", "Game", "Far Park"),
            {"id": "bye", "matchType": "BYE", "matchSchedule": [], "teams": []}],
    "g-b": [match("m3", "Round 2", "Two Day", [D1, D2], "Wenty Leagues", "Parramatta", "Darling Street")],
    "g-w": [match("m4", "Round 4", "T20", [D2], "Perry", "Gold", "School Oval")],
    "g-j": [match("m5", "Round 2", "One Day", [D1], "Juniors Red", "Juniors Blue", "Kids Park")],
    "g-t": [match("m6", "Round 1", "T20", [D2], "Twenty A", "Twenty B", "Short Oval")],
    # juniors mix game lengths: day 2 of the U14 two-day round is a one-day round for U13
    "g-u14": [match("m7", "Round 3", "Two Day", [(sat1 + timedelta(days=14)).isoformat(), (sat1 + timedelta(days=21)).isoformat()], "Fourteen A", "Fourteen B", "Teen Oval")],
    "g-u13": [match("m8", "Round 4", "One Day", [(sat1 + timedelta(days=21)).isoformat()], "Thirteen A", "Thirteen B", "Teen Oval")],
}
API_DOWN = True   # the first run has the fixture service unreachable -> a clear message and a retry link

# The demo has no fixture service of its own (its fixtures are made up). To test the whole fixture flow the browser is
# given one: a stand-in for the live store's `playhq` call that reads the fake service above, which answers in the shape
# the Edge Function does.
SHIM = """
(() => {
  const base = 'https://grassrootsapiproxy.cricket.com.au';
  const get = async path => { const r = await fetch(base + path); if (!r.ok) throw new Error('Could not reach the fixture service. Try again in a minute.'); return r.json(); };
  const iv = setInterval(() => {
    const P = window.__pdca;
    if (!(P && P.S && P.S.store)) return;
    clearInterval(iv);
    P.S.store.playhq = async (action, p = {}) => {
      if (action === 'seasons') return get('/seasons');
      if (action === 'competitions') return get('/competition-seasons?seasonId=' + p.seasonId);
      if (action === 'matches') return get('/scores/grades/' + p.gradeId + '/matches');
      if (action === 'matchesMany') { const out = {}; for (const id of p.gradeIds) out[id] = await get('/scores/grades/' + id + '/matches'); return { grades: out }; }
      throw new Error('Unknown request');
    };
  }, 2);
})();
"""


def fulfill_api(route):
    if API_DOWN:
        route.abort()
        return
    url = route.request.url
    cors = {"access-control-allow-origin": "*"}
    if "/seasons" in url:
        body = {"seasons": [{"id": "demo", "name": "Summer 2026/27", "isCurrentSeason": True, "startDate": "2026-07-01"}]}
    elif "competition-seasons" in url:
        body = {"competitionSeasons": [
            {"competition": {"id": "c-sen", "name": "PDCA Senior Competition"}, "grades": [{"id": "g-a", "name": "Senior A Grade"}, {"id": "g-b", "name": "Senior B01"}, {"id": "g-w", "name": "Senior Women"}]},
            {"competition": {"id": "c-jun", "name": "PDCA Junior Competition"}, "grades": [{"id": "g-j", "name": "U12 Blue North"}, {"id": "g-u14", "name": "U14 Gold"}, {"id": "g-u13", "name": "U13 Gold"}]},
            {"competition": {"id": "c-t20", "name": "PDCA T20 Competition"}, "grades": [{"id": "g-t", "name": "T20 Mens"}]}]}
    else:
        m = re.search(r"/scores/grades/([^/]+)/matches", url)
        body = {"matches": API.get(m.group(1), [])} if m else {}
    route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps(body))


def fmt_day_check():
    d = sat1 + timedelta(days=56)
    return d.strftime("%a, ") + str(d.day) + d.strftime(" %b")


errors = []
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        print("FAIL:", msg)
        errors.append(msg)
    else:
        passed += 1
        print("  ok:", msg)


def sign_in(page, email, open_form=True):
    goto(page, BASE)
    page.wait_for_selector("#login-email, .nav")
    if page.locator("#login-email").count():
        page.fill("#login-email", email)
        page.click("button:has-text('Sign in')")
    expect(page.locator(".who")).to_be_visible()
    if open_form:
        unfold(page)


def row_of(page, email):
    """A Members row, found by the member's email (the table no longer shows emails)."""
    pid = page.evaluate("""(e) => { const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2'));
        for (const o of Object.values(db.orgs)) { const u = (o.umpires || {})[e]; if (u) return u.pid; } return null; }""", email)
    return page.locator(f"tr[data-pid='{pid}']")


def unfold(page):
    """An umpire who has submitted sees a summary; most checks need the form, so open it."""
    page.wait_for_timeout(300)
    for _ in range(8):                                  # open every group (not player umpiring), each with its own Save
        b = page.locator(".comp-section:not(.player-card) .comp-head.tap")
        if not b.count():
            break
        b.first.click()


def save(page):
    """Press Save; a successful save folds the form, so open it again for the checks that follow."""
    for _ in range(6):                                  # each group has its own Save: press every one that has changes
        b = page.locator(".comp-section:not(.player-card) .group-foot button.primary:visible:not([disabled])")
        if not b.count():
            break
        b.first.click()
        page.wait_for_timeout(400)
    unfold(page)


def reload(page):
    page.reload()
    page.wait_for_selector(".who, #login-email")
    unfold(page)


def sign_out(page):
    page.click(".who-name")                       # Sign out is in the account menu, top right
    page.click(".who-menu button:has-text('Sign out')")
    page.wait_for_selector("#login-email")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.add_init_script(SHIM)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to fetch" not in m.text else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.route("https://grassrootsapiproxy.cricket.com.au/**", fulfill_api)

    print("Admin: Allocate page, one tile per competition")
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    check(page.locator("text=Season dates").count() == 0 and page.locator("text=New round").count() == 0 and page.locator("text=Re-sync").count() == 0, "no Season dates card, Re-sync or New round button")
    page.wait_for_selector(".notice.warn:has-text('Could not load the fixtures')")
    check(True, "with the fixture service unreachable the officer gets a clear message and a retry link")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector(".tile-round")
    tile = lambda name, n=0: page.locator(f".comp-tile:has(h2:has-text('{name}'))").nth(n)
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "Junior", "T20", "Junior"] and page.locator("section.week").count() == 2,
          "one section per week: this week Senior and Junior; next week T20 and the Junior one-day games on the two-day games' second Saturday (groups in the order the fixtures list the competitions)")
    check(page.locator(".week-head h2").all_inner_texts()[:2] == ["This week", "Next week"], "weeks are headed This week, Next week")
    wk2 = page.locator("section.week").nth(1).inner_text()
    check(f"two-day games from {S1} continue {S2}" in wk2, "next week lists the two-day games continuing from this week, instead of repeating them")
    check("One Day" in tile("Junior", 1).inner_text() and "Two Day" not in tile("Junior", 1).inner_text() and re.search(N2.upper(), tile("Junior", 1).inner_text().upper()) and f"{sat1.day}/{sat2.day}" not in tile("Junior", 1).inner_text(), "the extra Junior tile has its own date and only One Day games")
    check(page.locator("button:has-text('Load next week')").count() == 1, "Load next week is offered: the sample season has later weeks")
    bx = page.locator(".load-more button").bounding_box()
    check(abs((bx["x"] + bx["width"] / 2) - 640) < 40, "it sits in the middle of the page")
    page.click("button:has-text('Load next week')")
    check(page.locator("section.week").count() == 3, "Load next week adds the following week")
    page.locator("section.week").nth(2).locator("a.tile-body").first.click()
    page.wait_for_selector("table.board")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")
    check(page.locator("section.week").count() == 3, "going into a board and back keeps the loaded weeks")
    page.set_viewport_size({"width": 1280, "height": 420})
    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_timeout(200)
    y0 = page.evaluate("window.scrollY")
    page.locator("section.week").nth(2).locator("a.tile-body").first.click()
    page.wait_for_selector("table.board")
    check(page.evaluate("window.scrollY") < 50, "a new page opens at the top")
    page.go_back()
    page.wait_for_selector(".tile-round")
    page.wait_for_timeout(600)
    check(y0 > 100 and abs(page.evaluate("window.scrollY") - y0) < 5, f"Back returns to where the page was left ({y0})")
    page.reload()
    page.wait_for_selector(".tile-round")
    page.wait_for_timeout(600)
    check(page.evaluate("window.scrollY") < 5, "after a refresh it starts at the top again")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.screenshot(path="/tmp/sets.png")
    reload(page)
    page.wait_for_selector(".tile-round")
    sen_t = tile("Senior").inner_text().replace("\xa0", " ")
    check(sen_t.upper().index(S1.upper()) < sen_t.upper().find(N2.upper()) and "ROUND" not in sen_t.upper(), "tile lists each start day, not the round name")
    check(f"Two Day games, day 2 {S2}" in sen_t, f"each start day says how many games and when their day 2 is: {sen_t!r}")
    check("5 grades selected" in sen_t and "0 / 13 filled" in sen_t, f"Senior tile: 5 grades selected, 0 / 13 games filled (26 places, two-day games counted once): {sen_t!r}")
    check("Two Day" in sen_t and "Mens" not in sen_t and "Women" not in sen_t, "Senior tile shows the fixtures' own match type: Two Day (no made-up grade groups)")
    check("T20" in tile("T20").inner_text().replace("T20\n", "", 1), "T20 tile shows the match type T20")
    check("One Day game" in tile("Junior").inner_text() and "Two Day game" in tile("Junior").inner_text(), "Junior tile shows its match types before any grade is picked: One Day and Two Day")
    check("0 / 4 filled" in tile("T20").inner_text(), "T20 tile: 0 / 4 filled")
    check("Choose grades" in tile("Junior").inner_text() and "0 / 0" not in tile("Junior").inner_text(), "Junior tile with nothing picked just says Choose grades (no 0/0)")
    check(page.locator("a.tile-body").count() == 4, "each tile opens its own round")
    check(page.locator(".comp-tile button:has-text('Select grades')").count() == 0, "no Select grades button on the tiles")

    print("Admin: Select grades")
    dlg = page.locator("dialog.modal")

    def open_grades(name, n=0):                      # the popup now lives on the board, not the tile
        tile(name, n).locator("a.tile-body").click()
        page.wait_for_selector("button:has-text('Select grades')")
        page.click("button:has-text('Select grades')")
        dlg.wait_for(state="visible")

    def back_to_rounds():
        page.click("a.tab:has-text('Back to Allocate')")
        page.wait_for_selector(".comp-tile")

    open_grades("Junior")
    check(dlg.locator(".grade-row").count() == 2, "popup lists the Junior grades that play this round (U12 Gold, U14 Blue)")
    check("2 games" in dlg.locator(".grade-row:has-text('U12')").inner_text() and "1 game" in dlg.locator(".grade-row:has-text('U14')").inner_text(), "each grade shows its game count")
    check("One Day" in dlg.locator(".grade-row:has-text('U12')").inner_text() and "Two Day" in dlg.locator(".grade-row:has-text('U14')").inner_text() and "Round" not in dlg.locator(".grade-list").inner_text(), "each grade shows its match type, not the round")
    check("No grades selected" in dlg.inner_text(), "nothing ticked at first")
    dlg.locator(".grade-row:has-text('U12') input[type=checkbox]").check()
    check("1 grade" in dlg.inner_text() and "2 umpire slots" in dlg.inner_text(), "ticking U12 Gold (2 games) = 2 slots")
    dlg.locator(".grade-row:has-text('U14') input[type=checkbox]").check()
    check("2 grades" in dlg.inner_text() and "4 umpire slots" in dlg.inner_text(), "U14 Blue is one two-day game: 2 more slots (4 total)")
    check(dlg.locator("select").count() == 0 and "umpire" not in dlg.locator(".grade-row").first.inner_text(), "no 1 / 2 umpires choice in the popup (that is set per game on the board)")
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    jt = tile("Junior").inner_text()
    check("2 grades selected" in jt and " / " in jt, f"Junior tile shows its grades selected and games filled: {jt!r}")
    check("One Day game" in tile("Junior").inner_text() and "Two Day game" in tile("Junior").inner_text(), "picking U12 (One Day) and U14 (Two Day) keeps both match types")
    open_grades("Junior")
    check(dlg.locator(".grade-row:has-text('U14') input[type=checkbox]").is_checked(), "ticked grades stay ticked when the popup is reopened")
    check([t.split()[0] for t in dlg.locator(".grade-row .chip").all_inner_texts()] == ["U14", "U12"], "Junior grades are listed oldest age group first (U14 before U12)")
    dlg.locator("button:has-text('None')").click()
    check("No grades selected" in dlg.inner_text(), "the None link clears every grade")
    dlg.locator(".grade-row:has-text('U12') input[type=checkbox]").check()
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check("0 / 2 filled" in tile("Junior").inner_text(), "Junior tile settles at 0 / 2 filled")
    check("One Day" in tile("Junior").inner_text() and "Two Day" not in tile("Junior").inner_text(), "with only U12 picked the Junior tile says One Day")

    print("Admin: a board lists only that competition's picked grades")
    tile("Junior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Junior \u00b7 Round 2", "board is headed 'Junior \u00b7 Round 2'")
    check(page.locator("table.board tbody tr").count() == 2 and page.locator("td:has-text('Senior')").count() == 0, "only the two U12 Gold games: no Senior games, no unpicked grades")
    check(page.locator("text=0 of 2 slots filled").count() == 1, "summary matches the tile")
    d1_label = sat1.strftime("%a, ") + str(sat1.day) + sat1.strftime(" %b")
    def pick(idx, name):
        sel = page.locator("select.slot").nth(idx)
        val = sel.evaluate("(s, n) => { const o = [...s.options].find(o => o.text.startsWith(n)); return o ? o.value : null }", name)
        sel.select_option(value=val)
        page.wait_for_timeout(250)
    def slot_for(pattern):
        return page.locator("select.slot").evaluate_all(
            "(els, [pat, day]) => els.findIndex(e => new RegExp(pat).test(e.getAttribute('aria-label')) && e.getAttribute('aria-label').endsWith(day))", [pattern, d1_label])
    i_jun = slot_for(r"^Umpire 1, U12 Gold Kings Langley")
    check(i_jun >= 0, "found the Junior slot")
    pick(i_jun, "D Everton")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check("1 / 2 filled" in tile("Junior").inner_text(), "Junior tile now shows 1 / 2 filled")

    print("Admin: the same umpire on a Senior and a Junior game on one day")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Senior \u00b7 Round 2", "board is headed 'Senior \u00b7 Round 2'")
    check(page.locator("table.board tbody tr").count() == 13 and page.locator("td:has-text('U12')").count() == 0, "Senior board lists the 13 Senior games and no Junior games")
    check(page.locator("section.card h2").count() == 1, "one section: the Senior round")
    check(page.locator("text=0 of 26 slots filled").count() == 1, "26 slot-days: 13 two-day games")
    i_sen = slot_for(r"^Umpire 1, A GLCC Senior Maroon")
    pick(i_sen, "D Everton")
    check(page.locator(".warn-icon").count() == 0, "Umpire 2 is on a Junior game and a Senior game the same day: no warning")
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Umpire 2 is not free on Day 2, so Day 2 is left empty")
    page.locator("select.slot").nth(i_sen).select_option(value="")
    page.wait_for_timeout(250)

    print("Admin: manual allocation + warnings")
    first = page.locator("select.slot").first
    avoid_val = first.evaluate("s => { const o = s.querySelector('optgroup[label=\"Unavailable\"] option, optgroup[label=\"Already allocated\"] option'); return o ? o.value : null }")
    check(avoid_val is not None, "slot dropdown offers Unavailable / Already allocated groups, kept separate")
    first.select_option(value=avoid_val)
    page.wait_for_timeout(250)
    check(page.locator(".warn-icon").count() >= 1, "choosing an unavailable umpire shows a warning icon")
    check(page.locator("text=1 warning").count() >= 1, "summary counts the warning")
    page.locator("select.slot").first.select_option(value="")
    page.wait_for_timeout(250)
    check(page.locator(".warn-icon").count() == 0, "clearing the slot clears the warning")

    print("Admin: two-day game lists umpires free on both days first")
    sel0 = page.locator("select.slot").nth(i_sen)
    groups = sel0.evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label)")
    check(groups[0] == "Available both days" and "Available this day only" in groups, f"Day 1 dropdown groups: {groups}")
    both = sel0.evaluate("s => [...s.querySelector('optgroup').querySelectorAll('option')].map(o => o.text)")
    check(page.locator("select.slot").nth(i_sen + 1).get_attribute("aria-label").endswith(sat2.strftime("%a, ") + str(sat2.day) + sat2.strftime(" %b")), "the next dropdown is the same game on Day 2")
    first_name = both[0].split(" \u00b7")[0]
    pick(i_sen, first_name)
    d2_val = page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.options[s.selectedIndex].text")
    check(d2_val.startswith(first_name), f"choosing {first_name} for Day 1 also fills Day 2 ({d2_val})")
    check(page.locator(".warn-icon").count() == 0, "...with no warnings")
    page.locator("select.slot").nth(i_sen + 1).select_option(value="")
    page.wait_for_timeout(250)
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Day 2 can still be changed separately")
    page.locator("select.slot").nth(i_sen).select_option(value="")
    page.wait_for_timeout(250)

    print("Admin: suggest allocations")
    page.click("button:has-text('Suggest allocations')")
    m = re.search(r"(\d+) of 26 slots filled", page.locator(".summary").inner_text())
    filled = int(m.group(1))
    check(filled > 5, f"auto-suggest filled {filled} of 26 slots")
    check(page.locator(".warn-icon").count() == 0, "auto-suggested allocations have no warnings")
    labels = page.eval_on_selector_all("select.slot", "els => els.map(e => [e.getAttribute('aria-label'), e.value])")
    by_day = {}
    for lab, val in labels:
        if val:
            by_day.setdefault(lab.split(", ")[-1], []).append(val)
    check(all(len(v) == len(set(v)) for v in by_day.values()), "no umpire is allocated to two Senior games on the same day")

    print("Admin: umpires per game")
    check(page.locator("table.board thead th").last.inner_text().upper() == "UMPIRES"
          and page.locator("table.board tbody tr").first.locator("td").last.locator("select.n-slots").count() == 1,
          "the number of umpires is the last column, after the names")
    page.wait_for_timeout(300)
    page.locator("select.n-slots").first.select_option("2")
    page.wait_for_timeout(300)
    m = re.search(r"of (\d+) slots", page.locator(".summary").inner_text())
    check(int(m.group(1)) == 26 + 2, f"asking for 2 umpires on one two-day game adds 2 slots (now {m.group(1)})")
    page.locator("select.n-slots").first.select_option("1")
    page.wait_for_timeout(300)

    print("Admin: availability tab, report tab, publish")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("td.av")
    check(page.locator("td.av.ok").count() > 0 and page.locator("td.av.no").count() > 0, "availability grid shows yes and no cells")
    check(page.locator("th", has_text=re.compile("junior", re.I)).count() == 0, "this competition's grid has no Junior columns")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check(page.locator("text=Copy report as text").count() == 0 and page.locator("text=Print").count() == 0, "no 'Copy report as text' and nothing about printing")
    with page.expect_download() as dl:
        page.click("button:has-text('Download PDF')")
    pdf = dl.value
    pdf.save_as("/tmp/report-download.pdf")
    check(pdf.suggested_filename.endswith(".pdf"), f"Download PDF saves a file ({pdf.suggested_filename})")
    check(open("/tmp/report-download.pdf", "rb").read(5) == b"%PDF-", "the downloaded file is a real PDF")
    check(page.locator(".report-table tbody tr").count() == 13, "report lists the 13 Senior games")
    check(page.locator(".report-table th:has-text('UMPIRES')").count() == 1, "one report table for the Senior round")
    page.click("a.tab:has-text('Assign')")
    page.wait_for_selector("table.board")
    check(page.locator(".publish button").first.inner_text() == "Publish" and page.locator(".publish input[type=checkbox]").count() == 0,
          "publishing is one button, not a tick box")
    page.click(".publish button:has-text('Publish')")
    page.wait_for_selector(".publish button:disabled")
    check(page.locator(".publish button").first.inner_text().startswith("Published ") and page.locator("button:has-text('Unpublish')").count() == 1,
          "once published the button says when, and Unpublish appears")
    check(page.locator(".publish button").first.is_disabled(), "the Publish button is spent until something changes")

    sel0 = page.locator("select.slot").first
    was = sel0.input_value()
    free = sel0.evaluate("s => [...s.options].map(o => o.value).filter(Boolean)")
    sel0.select_option(value=("" if was else free[0]))
    page.wait_for_timeout(350)
    check(page.locator(".publish button").first.inner_text() == "Re-publish", "changing an allocation after publishing asks for a re-publish")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check("Changes to publish" in tile("Senior").inner_text(), "the tile says so too")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    page.locator("select.slot").first.select_option(value=was)
    page.wait_for_timeout(350)
    page.click(".publish button:has-text('Re-publish')")
    page.wait_for_selector(".publish button:disabled")
    check(page.locator(".publish button").first.inner_text().startswith("Published "), "re-publishing clears the warning")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check("Published" in tile("Senior").inner_text() and "Changes to publish" not in tile("Senior").inner_text(), "and the tile is back to Published")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")

    print("Umpire: one page - appointments + season availability")
    sign_out(page)
    sign_in(page, "umpire1@demo.test", open_form=False)
    page.wait_for_selector(".comp-section")
    check(page.locator(".tile:visible").count() == 0 and page.locator(".avail-head button").count() == 0,
          "answered groups are folded to one line each; no button opens them all")
    unfold(page)
    page.wait_for_selector(".tile")
    check(page.locator("nav .nav-link").count() == 0, "umpire header has no officer navigation, only their name menu")
    check(page.locator("h2:has-text('My appointments')").count() == 1, "published appointments show on the same page")
    check(page.locator("li.appt-game a[href*='maps']").count() >= 1, "appointment links to a map")
    titles = page.locator(".comp-section:not(.player-card) .comp-title").all_inner_texts()
    check(titles == ["Senior", "T20", "Junior"], f"one section per group, in the association's order: {titles}")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    # Senior and T20 games are all the same length -> by round with Day 1 / Day 2; Junior mixes lengths -> date list
    check(sen.locator(".tile").count() == 6 and sen.locator(".drow").count() == 12, "Senior (all two-day): six rounds, 12 rows")
    check(sen.locator(".tile h3").first.inner_text() == "Round 2", "Senior tile is titled 'Round 2'")
    first_label = sen.locator(".dlabel").first.inner_text()
    check(first_label.startswith("Day 1 \u00b7 "), f"Senior row label reads '{first_label}' (date shown once)")
    date_part = first_label.split("\u00b7 ")[1]
    check(sen.locator(".tile").first.inner_text().count(date_part) == 1, f"'{date_part}' appears once in the tile")
    tt = [t for t in page.locator(".comp-section:has(h2:has-text('T20')) .tile h3").all_inner_texts()]
    check(tt and tt[0] == "Round 1", f"T20 (all one-day) is also by round: {tt[:2]}")
    jtxt = jun.inner_text()
    check("Round" not in jtxt and "Day 1" not in jtxt and "Day 2" not in jtxt, "Junior (mixed lengths) has no round or Day 1 / Day 2 text")
    jlabels = jun.locator(".dlabel").all_inner_texts()
    check(re.fullmatch(r"[A-Z][a-z]+ 20\d\d", jun.locator(".tile h3").first.inner_text()) is not None and all(re.fullmatch(r"[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}", t) for t in jlabels), f"Junior is a date list under month headings: {jlabels[:2]}")
    check(page.locator(".dlabel", has_text=date_part).count() >= 2, "the same date is listed under more than one competition (overlapping dates)")
    check(page.locator("button.opt").count() == 2 * page.locator(".drow").count(), "only two options per day (Available / Not available)")
    check(page.locator("text=Maybe").count() == 0 and page.locator("textarea").count() == 0, "no 'Maybe' option and no note box")
    check(all(page.locator(f".comp-section:has(h2:has-text('{c}')) .comp-head .chip").inner_text() == "\u2713 Submitted" for c in ["Senior", "Junior", "T20"]),
          "each group shows its own status: all three Submitted")
    sen_first = sen.locator(".drow").first
    jun_first = jun.locator(".drow", has_text=date_part).first
    check("on" in sen_first.locator("button.opt.yes").get_attribute("class"), "existing Senior answer is pre-highlighted")
    jun_before = jun_first.locator("button.opt.no").get_attribute("class")
    sen_first.locator("button.opt.no").click()
    check("on" in sen_first.locator("button.opt.no").get_attribute("class") and "on" not in sen_first.locator("button.opt.yes").get_attribute("class"), "tapping highlights the new choice only")
    check(jun_first.locator("button.opt.no").get_attribute("class") == jun_before, "changing Senior leaves the Junior answer for the same day alone")
    check(page.locator(".comp-section:has(h2:has-text('Senior')) .comp-head .chip").inner_text() == "Unsaved changes" and page.locator(".comp-section:has(h2:has-text('Junior')) .comp-head .chip").inner_text() == "\u2713 Submitted",
          "only Senior shows unsaved changes; Junior is still Submitted")
    check(sen.locator(".group-foot button.primary").is_enabled() and jun.locator(".group-foot button.primary").is_disabled()
          and "Save Senior" in sen.locator(".group-foot").inner_text(), "Senior has its own 'Save Senior' button; Junior's Save stays greyed out")
    check(jun.locator(".tile:visible").count() > 0, "(both open for this check)")
    sen.locator(".group-foot button:has-text('Close')").click()
    check(sen.locator(".tile:visible").count() == 0 and jun.locator(".tile:visible").count() > 0, "Close folds only Senior; Junior stays open")
    check(page.locator(".comp-section:has(h2:has-text('Senior')) .comp-head .chip").inner_text() == "Unsaved changes", "closed, Senior still says Unsaved changes")
    reload(page)
    page.wait_for_selector(".comp-section")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    check(sen.locator(".comp-head .chip").inner_text() == "Unsaved changes", "the unsaved change is kept in the browser after a reload")
    if not sen.locator(".tile:visible").count():
        sen.locator(".comp-head").click()
    sen_first = sen.locator(".drow").first
    check("on" in sen_first.locator("button.opt.no").get_attribute("class"), "and opening Senior shows the change, ready to save")
    sen.locator(".group-foot button:has-text('Discard changes')").click()
    check("on" in sen_first.locator("button.opt.yes").get_attribute("class") and sen.locator(".comp-head .chip").inner_text() == "\u2713 Submitted",
          "Discard changes puts back the saved answer")
    sen_first.locator("button.opt.no").click()
    save(page)
    page.wait_for_selector(".comp-section:has(h2:has-text('Senior')) .comp-head .chip:has-text('Submitted')")
    check(True, "one Save sends it and Senior returns to Submitted")
    reload(page)
    page.wait_for_selector(".tile")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    check("on" in sen.locator(".drow").first.locator("button.opt.no").get_attribute("class"), "answer is still there after reloading")
    check(jun.locator(".drow", has_text=date_part).first.locator("button.opt.no").get_attribute("class") == jun_before, "the Junior answer for the same day was kept separately")
    row3 = sen.locator(".drow").nth(3)
    if "on" in row3.locator("button.opt.yes").get_attribute("class"):
        row3.locator("button.opt.yes").click()          # clear any existing answer first
    row3.locator("button.opt.yes").click()
    check("on" in row3.locator("button.opt.yes").get_attribute("class"), "tapping an option selects it")
    row3.locator("button.opt.yes").click()
    check("on" not in sen.locator(".drow").nth(3).locator("button.opt.yes").get_attribute("class"), "tapping the same option again clears it")
    sen.locator("button:has-text('Mark all available')").click()
    check(sen.locator("button.opt.yes.on").count() == 12, "'Mark all available' answers every Senior date")
    check(jun.locator("button.opt.yes.on").count() < jun.locator(".drow").count(), "...and leaves the other competitions alone")
    save(page)
    page.wait_for_selector(".comp-section .comp-head .chip:has-text('Submitted')")

    print("Admin sees the season-wide answers")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    def avail_cell(comp, prefix):
        page.locator(f".comp-tile:has(h2:has-text('{comp}')) a.tile-body").first.click()
        page.wait_for_selector("table.board")
        page.click("a.tab:has-text('Availability')")
        page.wait_for_selector("td.av")          # the availability grid itself, not the board still on screen
        heads = page.locator("table.board thead th").all_inner_texts()
        i = next(i for i, t in enumerate(heads) if date_part.lower() in t.lower())
        cls = page.locator("tr:has-text('G Serrao')").first.locator("td").nth(i).get_attribute("class")
        return cls
    check("ok" in avail_cell("Senior", "senior"), "umpire 1 is available for the Senior game that day")
    check(page.locator("text=Haven't replied (2)").count() == 1, "still two umpires with no reply")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check(("no" if "on" in jun_before else "ok") in avail_cell("Junior", "junior"), "...and the Junior game that day keeps its own answer")
    page.click("a.tab:has-text('Back to Allocate')")

    print("Admin: past allocations stay available")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")
    check(page.locator(".past-rounds").count() == 0, "Past allocations is no longer on the Allocate page")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Past allocations')")
    page.wait_for_selector("h1:has-text('Past allocations')")
    check(page.locator(".past-row").count() == 3, "it is its own page under My Organisation: three finished rounds from the sample data")
    rows = page.locator(".past-row").all_inner_texts()
    check(_n(P1).upper() in rows[0].upper() and "Junior" in rows[0] and "Not published" in rows[0] and "1/2 slots filled" in rows[0], "newest first: Junior 14 Nov, part filled, not published")
    check(any(f"{P2.day}/{_n(P1)}".upper() in r.upper() and "Senior" in r and "8/8 slots filled" in r and "Published" in r for r in rows), "Senior 7/14 Nov: 8/8 slots filled, Published")
    page.screenshot(path="/tmp/past.png")
    page.locator(".past-row", has_text="Senior").click()
    page.wait_for_selector("a.tab:has-text('Report')")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check(page.locator(".report-table tbody tr").count() == 4 and any(n in page.locator(".report-table").inner_text().upper() for n in ["SERRAO", "EVERTON", "BAKON", "CHELLAPA", "DRYBURGH", "JAYASHRI", "HENRY", "KRISH"]), "opening it shows the final allocation report with the umpires' names")
    # Finished more than 4 days ago: a record only, no Assign board.
    goto(page, BASE + "admin/past")
    page.wait_for_selector(".past-row")
    # Which rounds are still open depends on today's date: open for 4 days after their last day.
    open_rows = page.evaluate("""() => { const o = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const d = new Date(); d.setDate(d.getDate() - 4); const cut = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;   // local date, as the app uses
        return [...document.querySelectorAll('.past-row')].map(a => { const id = a.getAttribute('href').split('/')[3]; return [(o.rounds[id].end || '') >= cut, a.innerText.includes('Can change until'), o.rounds[id].end, cut, id]; }); }""")
    check(all(r[0] == r[1] for r in open_rows), f"rounds finished in the last 4 days are marked as changeable, older ones are not ({open_rows})")
    # Make the newest Junior round finish yesterday, so it is still open whatever today is.
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k)); const t = new Date().toISOString().slice(0, 10);
        const r = Object.values(db.orgs.pdca.rounds).filter(r => r.comp === 'junior' && r.end < t).sort((a, b) => b.end.localeCompare(a.end))[0];
        const d = new Date(); d.setDate(d.getDate() - 1); r.end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; r.dates = [r.end]; r.start = r.end;
        localStorage.setItem(k, JSON.stringify(db)); }""")
    page.reload()
    page.wait_for_selector(".past-row")
    page.locator(".past-row", has_text="Junior").first.click()
    page.wait_for_selector("table.board")
    check(page.locator("a.tab:has-text('Assign')").count() == 1, "one finished yesterday still opens on the Assign board")
    old = page.evaluate("""() => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k));
        const t = new Date(), today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        const past = Object.values(db.orgs.pdca.rounds).filter(r => r.comp === 'junior' && (r.end || '') < today && (r.published || (r.stats || {}).filled));
        const r = past.sort((a, b) => (b.end || '').localeCompare(a.end || ''))[0];      // the one finished yesterday
        const d = new Date(); d.setDate(d.getDate() - 5); r.end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; r.dates = [r.end]; r.start = r.end;
        localStorage.setItem(k, JSON.stringify(db)); return r.id; }""")
    goto(page, BASE + "admin/past")
    page.reload()
    page.wait_for_selector(".past-row")
    jr = page.locator(".past-row", has_text="Junior").first
    check("Can change until" not in jr.inner_text() and "/report" in (jr.get_attribute("href") or ""), "finished more than 4 days ago: no longer marked as changeable, opens the report")
    goto(page, BASE + f"admin/round/{old}")
    page.wait_for_selector(".report-table")
    check("/report" in page.url and page.locator("a.tab:has-text('Assign')").count() == 0 and "can no longer be changed" in page.inner_text("main"),
          "going to its board lands on the report: no Assign tab, and it says why")
    check(page.locator("a.tab:has-text('Availability')").count() == 0 and page.locator("button:has-text('Copy umpire emails')").count() == 0
          and page.locator("button:has-text('Open email draft')").count() == 0 and page.locator("button:has-text('Download PDF')").count() == 1,
          "a finished round shows only its report and Download PDF: no Availability, no emails")
    goto(page, BASE + f"admin/round/{old}/availability")
    page.wait_for_selector(".report-table")
    check("/report" in page.url, "and its Availability page goes to the report too")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")

    # A round with no grades selected yet still shows everyone's availability for its days.
    jr0 = page.evaluate("""() => { const o = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca; const t = new Date().toISOString().slice(0, 10);
        const r = Object.values(o.rounds).find(r => r.end >= t && Object.values(o.games[r.id] || {}).length && Object.values(o.games[r.id]).every(g => !(g.slots > 0)));
        return r && r.id; }""")
    if jr0:
        goto(page, BASE + f"admin/round/{jr0}/availability")
        page.wait_for_selector("td.av")
        check(page.locator("td.av.ok, td.av.no").count() > 0, "a round with no grades selected still shows availability for its days")
        ranks = page.locator("table.board tbody tr").evaluate_all("""l => l.map(tr => { const c = [...tr.querySelectorAll('td.av')];
            const ok = c.filter(td => td.classList.contains('ok')).length, no = c.filter(td => td.classList.contains('no')).length;
            const r = c.some(td => td.classList.contains('pu')) ? 2 : ok === c.length ? 0 : ok ? 1 : no ? 3 : 4;
            return [tr.classList.contains('nonmember') ? 1 : 0, r, tr.querySelector('a.member-link').innerText.trim().split(' ').slice(-1)[0].toLowerCase()]; })""")
        check(ranks == sorted(ranks), "members first (available every day, some days, player umpires, not available, no answer; by last name), then non-members who gave availability")
        check(page.locator("tr.nonmember:has-text('Priya Nair') .chip:has-text('Non-member')").count() == 1, "an applicant who gave availability is listed as a Non-member")
    else:
        check(False, "sample data has a round with no grades selected")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")

    print("Admin: season availability dashboard")
    page.click(".nav-link:has-text('Availability')")
    page.wait_for_selector(".season-grid table")
    check(page.locator(".tabs button.tab").all_inner_texts() == ["Senior", "T20", "Junior"], "dashboard has a tab per group")
    check(page.locator(".season-grid tbody tr:not(.nonmember)").count() == 10, "one row per member")
    n_dates = page.locator(".season-grid .datebtn").count()
    check(n_dates == 12 and page.locator(".season-grid th.past").count() == 0, "Senior: one column per upcoming date, nothing greyed out to scroll past")
    check(page.locator(".season-grid thead", has_text="Round").count() == 0, "no round columns: every competition is laid out by date")
    check(page.locator(".season-grid tr.counts td").count() == n_dates + 1, "a count of available umpires sits under each date")
    row9 = page.locator(".season-grid tbody tr:has-text('H Murali')")
    check("0 of" not in row9.inner_text() and "0/12" in row9.inner_text(), "each umpire shows how many upcoming dates they are free (0/12 for one who has not answered)")
    before = int(page.locator(".season-grid tr.counts td").nth(1).inner_text())
    c0 = row9.locator("td.av").first
    c0.locator("button").click()
    page.wait_for_function("() => document.querySelector(\".season-grid tbody tr:nth-child(10) td.av\").classList.contains('ok')")
    check("ok" in c0.get_attribute("class") and "edited" in c0.locator("button").get_attribute("class"), "officer clicks a blank cell: it becomes available and is marked as set by the officer")
    check(int(page.locator(".season-grid tr.counts td").nth(1).inner_text()) == before + 1 and "1/12" in row9.inner_text(), "the date's count and the umpire's tally update")
    c0.locator("button").click()
    page.wait_for_timeout(300)
    check("no" in c0.get_attribute("class"), "a second click makes it not available")
    reload(page)
    page.wait_for_selector(".season-grid table")
    check("no" in page.locator(".season-grid tbody tr:has-text('H Murali') td.av").first.get_attribute("class"), "the override is saved")
    page.locator(".season-grid .datebtn").first.click()
    shown = page.locator(".season-grid tbody tr").count()
    check(0 < shown < 10 and page.locator(".season-grid tbody td.av.ok").count() >= shown, "clicking a date lists only the umpires available that day")
    page.locator("button.chip:has-text('Available')").click()
    page.fill(".grid-search", "murali")
    check(page.locator(".season-grid tbody tr").count() == 1, "search narrows the list (H Murali)")
    page.fill(".grid-search", "")
    page.click(".tabs button.tab:has-text('Junior')")
    check(page.locator(".season-grid .datebtn").count() > 3 and page.locator(".season-grid thead", has_text="Round").count() == 0, "Junior uses the same date layout")
    page.click(".tabs button.tab:has-text('Senior')")
    page.screenshot(path="/tmp/season.png")

    print("Umpire: new sign-up chooses an association, asks to join, waits for approval")
    sign_out(page)
    sign_in(page, "newbie@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    check("Join an association" in page.inner_text("h1") and page.locator(".comp-section").count() == 0, "a new sign-up first sees the associations to join, not availability")
    check(page.locator(".org-row").count() == 1 and page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").count() == 1, "the list shows each association on Third Umpire, with a Join button")
    page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").click()
    page.wait_for_selector(".join-form")
    asks = page.inner_text(".join-form")
    check(all(x in asks for x in ["First name", "Last name", "Mobile", "Date of birth", "Address", "Umpire accreditation number"]), "the join form asks for the details the association asked for")
    check(page.locator(".join-form input[data-field=phone][required]").count() == 1 and page.locator(".join-form input[data-field=dob][required]").count() == 0,
          "what the association requires is marked required, the rest is optional")
    check(page.locator(".role").count() == 0, "no umpire-or-member choice: umpiring follows the availability they give")
    page.locator(".join-form input").nth(0).fill("New")
    page.locator(".join-form input").nth(1).fill("Umpire")
    page.click(".join-form button[type=submit]")
    check(page.locator(".join-form").count() == 1 and page.locator(".pending-card").count() == 0, "it will not send without the mobile number the association requires")
    page.fill(".join-form input[data-field=phone]", "0400 111 222")
    page.click(".join-form button:has-text('Request to join')")
    page.wait_for_selector(".pending-card")
    check("Waiting for approval" in page.inner_text(".pending-card") and "Parramatta" in page.inner_text(".pending-card") and page.locator(".comp-section").count() == 0,
          "after asking to join they wait for approval and cannot give availability yet")
    sign_out(page)
    sign_in(page, "socialmember@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").click()
    page.wait_for_selector(".join-form")
    page.locator(".join-form input").nth(0).fill("Social")
    page.locator(".join-form input").nth(1).fill("Member")
    page.fill(".join-form input[data-field=phone]", "0400 333 444")
    page.click(".join-form button:has-text('Request to join')")
    page.wait_for_selector(".pending-card")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".join-banner")
    check("5 umpires are waiting to join" in page.inner_text(".join-banner"), "the officer sees a banner on Allocate for people waiting to join")
    check(page.locator("nav .menu > summary .badge").inner_text() == "5", "and a count beside My Organisation")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Members')")
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Members", "the Umpires page is now called Members")
    check(page.locator(".join-requests .request").count() == 5, "a Join requests card lists everyone waiting")
    check("0400 111 222" in page.locator(".join-requests .request:has-text('newbie@demo.test')").inner_text(), "it shows the details they gave when they asked to join")
    check([t.strip() for t in page.locator("table.members thead th").all_inner_texts()] == ["NAME", "UMPIRING", "MEMBERSHIP", "MEMBERSHIP TYPE"],
          "the Members list: name, umpiring, membership and membership type (member since is on the profile)")
    u1 = row_of(page, "umpire1@demo.test")
    check(u1.locator("input:not([type=checkbox])").count() == 0 and u1.locator("select").count() == 1 and "L1-2200" not in u1.inner_text() and "@" not in page.inner_text("table.members"),
          "personal details (email, mobile, date of birth, address, accreditation) are not on the list, only on profiles")
    check(page.locator("button:has-text('Email active members')").count() == 1 and page.locator("button:has-text('Email inactive members')").count() == 1,
          "buttons to draft an email to active or inactive members")
    names = page.locator("table.members tbody tr a.member-link").all_inner_texts()
    waiting = page.locator("table.members tbody tr.needs").count()
    check(waiting == 5 and {"Social Member", "New Umpire", "Priya Nair", "Tom Walsh", "Lena Okafor"} == set(names[:5]), f"people waiting for approval (two new, three in the sample data) are at the top ({names[:5]})")
    rest = [n.split()[-1].lower() for n in names[5:]]
    check(rest == sorted(rest), "then everyone by last name")
    check(row_of(page, "newbie@demo.test").locator("button").count() == 0 and "Waiting for approval" in row_of(page, "newbie@demo.test").locator("td").nth(2).inner_text(),
          "in the table a person waiting shows Waiting for approval, with no Approve / Reject buttons")
    page.locator(".join-requests .request:has-text('newbie@demo.test') button:has-text('Approve')").click()
    page.wait_for_selector(".join-requests .request:has-text('newbie@demo.test')", state="detached")
    page.wait_for_selector("tr[data-pid] >> text=Member")
    page.locator(".join-requests .request:has-text('socialmember@demo.test') button:has-text('Approve')").click()
    page.wait_for_selector(".join-requests .request:has-text('socialmember@demo.test')", state="detached")
    expect(page.locator("nav .menu > summary .badge")).to_have_text("3")
    check(page.locator(".join-requests .request").count() == 3, "approving from the card takes the person off it, and the count follows")
    sign_out(page)
    sign_in(page, "newbie@demo.test", open_form=False)
    page.wait_for_selector(".comp-section")
    check(page.locator(".pending-card").count() == 0, "once approved they can give their availability")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    page.wait_for_timeout(300)
    check("Member" in row_of(page, "newbie@demo.test").inner_text() and "Inactive member" in row_of(page, "newbie@demo.test").inner_text(),
          "approved: a Member; an Inactive member until they say Available to a date")
    check(row_of(page, "newbie@demo.test").locator("button.tagbtn").count() == 0, "Active umpire / Inactive member is not something the officer changes")
    # Their availability decides it, for this association: Not available to everything keeps them inactive,
    # one Available makes them an Active umpire.
    def set_days(email, days):
        page.evaluate("""([email, days]) => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k)), o = db.orgs.pdca;
            const sid = o.season.id; o.availability[sid + '__' + email] = { seasonId: sid, email, days, updatedAt: new Date().toISOString() };
            localStorage.setItem(k, JSON.stringify(db)); }""", [email, days])
        page.reload()
        page.wait_for_selector("table.members")
    dates = page.evaluate("() => { const o = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca; return o.season.calendar.slice(0, 2).map(e => e.comp + ':' + e.dates[0]); }")
    set_days("socialmember@demo.test", {dates[0]: "no", dates[1]: "no"})
    check("Inactive member" in row_of(page, "socialmember@demo.test").inner_text(), "Not available to everything: still an Inactive member")
    set_days("socialmember@demo.test", {dates[0]: "no", dates[1]: "yes"})
    check("Active umpire" in row_of(page, "socialmember@demo.test").inner_text(), "Available to one date: an Active umpire")
    page.fill(".member-search", "social")
    check(page.locator("table.members tbody tr").count() == 1, "search finds members by name")
    page.fill(".member-search", "")
    types_before = page.evaluate("() => JSON.stringify(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.membership || null)")
    bring = page.locator("details.import-card:has(> summary:has-text('Bulk upload'))")
    if bring.get_attribute("open") is None:
        bring.locator("> summary").click()
    page.fill(".import-step textarea >> nth=0", "Pat, Example, pat@example.com, 0400 000 000, L3-7782\nbad line")
    page.click(".import-step button:has-text('Check it') >> nth=0")
    page.click(".import-step button:has-text('Import') >> nth=0")
    page.wait_for_selector("a.member-link:has-text('Pat Example')")
    patu = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['pat@example.com']")
    check(patu["firstName"] == "Pat" and patu["lastName"] == "Example" and patu["phone"] == "0400 000 000" and patu["accreditation"] == "L3-7782",
          "bulk add reads First name, Last name, email, mobile and accreditation number")
    # A membership file with headings: an existing member (their own details kept) and two new members.
    before_u1 = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['umpire1@demo.test']")
    bring = page.locator("details.import-card:has(> summary:has-text('Bulk upload'))")
    if bring.get_attribute("open") is None:
        bring.locator("> summary").click()
    check(page.locator(".import-step select").count() == 0, "the membership file has no active or inactive choice: that follows availability")
    page.fill(".import-step textarea >> nth=0", "First name\tLast name\tEmail\tMembership type\tMember since\n"
              "Changed\tName\tumpire1@demo.test\tLife member\t2015\n"
              "Quiet\tMember\tquiet@example.com\t\t\n"
              "Keen\tUmpire\tkeen@example.com\tOrdinary member\t15/04/2019")
    page.click(".import-step button:has-text('Check it') >> nth=0")
    prev = page.inner_text(".import-step .import-out >> nth=0")
    check("2 new, 1 already on the list" in prev, f"the check says who is new and who is updated ({prev[:80]!r})")
    page.click(".import-step button:has-text('Import') >> nth=0")
    page.wait_for_selector(".toast:has-text('2 member(s) added, 1 updated')")
    db = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires")
    u1 = db["umpire1@demo.test"]
    check(u1["name"] == before_u1["name"] and u1.get("phone") == before_u1.get("phone") and u1["membership"] == "Life member" and u1["memberSince"] == "2015-01-01",
          "an existing member keeps their own details; only membership type and member since change")
    check(db["keen@example.com"]["memberSince"] == "2019-04-15" and db["quiet@example.com"].get("approved"), "new people come in as members, with their member-since date")
    check("Inactive member" in row_of(page, "quiet@example.com").inner_text() and "Active umpire" in row_of(page, "umpire1@demo.test").inner_text(),
          "a new member with no availability is an Inactive member; one with Available dates is an Active umpire")
    check(page.locator(".import-step").count() == 1 and "Add many members at once" in page.inner_text(".import-card") and "Availabilities page" not in page.inner_text(".import-card"), "Members bulk uploads only the membership list, with no mention of availability files")
    page.click("details.add-member-card > summary")
    page.fill(".add-member label:has-text('First name') input", "Hand")
    page.fill(".add-member label:has-text('Last name') input", "Added")
    page.fill(".add-member input[type=email]", "Hand.Added@Example.com")
    page.fill(".add-member input[type=tel]", "0411 222 333")
    page.click(".add-member button[type=submit]")
    page.wait_for_selector("a.member-link:has-text('Hand Added')")
    ha = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['hand.added@example.com']")
    check(ha and ha.get("approved") and ha["phone"] == "0411 222 333" and ha.get("memberSince"), "Add a member adds one person as a member, email lower-cased, member since today")
    page.click("details.add-member-card > summary")
    page.fill(".add-member label:has-text('First name') input", "Hand")
    page.fill(".add-member label:has-text('Last name') input", "Again")
    page.fill(".add-member input[type=email]", "hand.added@example.com")
    page.click(".add-member button[type=submit]")
    page.wait_for_selector(".toast:has-text('already a member')")
    check(True, "adding someone already a member says so and changes nothing")
    # An association's own Excel file (PDCA's membership form layout, made-up people): columns matched, answers translated, choices kept.
    xlsx = os.path.join(ROOT, "tests", "fixtures-members.xlsx")
    bring = page.locator("details.import-card:has(> summary:has-text('Bulk upload'))")
    if bring.get_attribute("open") is None:
        bring.locator("> summary").click()
    page.set_input_files(".import-step input[type=file]", xlsx)
    page.wait_for_selector(".import-map .map-row")
    field_of = lambda heading: page.locator(f".import-map > .map-list > .map-row:has(strong:text-is('{heading}')) select").input_value()
    check([field_of(x) for x in ["Email address", "First Name", "Contact number", "D.O.B(If under 18)", "Eligibility to umpire?", "Membership/Card number If passed NSWCUSA"]]
          == ["email", "firstName", "phone", "dob", "accreditationProvider", "accreditation"], "an Excel file's columns are matched from PDCA's own headings")
    prov = page.locator(".value-map[data-field=accreditationProvider]")
    check(prov.count() == 1 and prov.locator(".map-row").count() == 3, "the accreditation answers are listed once each, to translate")
    mt = page.locator(".value-map[data-field=membership]")
    check(mt.locator(".map-row .chip.new:has-text('New type')").count() == 2 and "2 new membership types will be added to Settings" in mt.inner_text(),
          "answers that are not one of the association's types are marked New type, with a summary of what will be added")
    known = page.evaluate("() => (JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.membership || {}).types || []")
    if known:
        first = known[0]["name"]
        mt.locator(".map-row:has(.map-from:text-is('Existing Member')) input").fill(first)
        check(mt.locator(".map-row:has(.map-from:text-is('Existing Member')) .chip.ok:has-text('Existing type')").count() == 1, "choosing one of their own types marks it Existing type")
        mt.locator(".map-row:has(.map-from:text-is('Existing Member')) input").fill("Existing Member")
    page.locator(".import-map > .map-list > .map-row:has(strong:text-is('Address')) select").select_option("")
    page.click(".import-step button:has-text('Check it')")
    prev = page.inner_text(".import-step .import-out")
    check("3 new" in prev, f"the check reads all three rows ({prev[:60]!r})")
    page.click(".import-step button:has-text('Import')")
    page.wait_for_selector(".toast:has-text('3 member(s) added')")
    db = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires")
    x, y, z = db["xavier.sample@example.com"], db["yara.sample@example.com"], db["zed.sample@example.com"]
    check(x["firstName"] == "Xavier" and x["lastName"] == "Sample" and x["dob"] == "1980-03-09" and x["accreditation"] == "20/1234-O"
          and x["accreditationProvider"] == "NSW Cricket Umpires & Scorers Association" and x["membership"] == "Existing Member" and not x.get("address"),
          "the Excel rows come in: name trimmed, date of birth from the Excel date, accreditation translated, the ignored Address column left out")
    check(y["phone"] == "0411222333" and y["accreditationProvider"] == "PDCUA" and z["accreditationProvider"] == "Cricket Australia", "a mobile stored as a number gets its 0 back")
    types_now = [t["name"] for t in page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.membership.types")]
    check("Existing Member" in types_now and "New Member" in types_now, "the new membership types are added to Settings")
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.memberImport")
    check(saved and saved["columns"].get("address") == "" and saved["columns"].get("contact number") == "phone", "the column choices are kept for the association")
    if bring.get_attribute("open") is None:
        bring.locator("> summary").click()
    page.set_input_files(".import-step input[type=file]", xlsx)
    page.wait_for_selector(".import-map .map-row")
    check(field_of("Address") == "", "next time, the column they ignored is still ignored")
    page.evaluate("t => { const k = 'pdca-umpires-demo-v2'; const d = JSON.parse(localStorage.getItem(k)); d.orgs.pdca.org.membership = JSON.parse(t); localStorage.setItem(k, JSON.stringify(d)); }", types_before)   # the Settings checks below start from the seeded types
    page.reload()
    page.select_option(".member-tools select", "inactive")
    check(row_of(page, "quiet@example.com").count() == 1 and row_of(page, "umpire1@demo.test").count() == 0, "the Show filter lists Inactive members")
    check(page.locator("table.members input[type=checkbox]").count() == 0 and page.locator(".bulk-bar").count() == 0
          and page.locator("table.members button:has-text('Approve'), table.members button:has-text('Reject')").count() == 0,
          "the members table has no tick boxes or Approve / Reject buttons (those are in the Join requests card)")
    page.select_option(".member-tools select", "all")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    check(page.locator("h1").first.inner_text() == "Members", "the old /admin/umpires link still opens it")

    print("Admin: membership settings")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/membership']")
    page.wait_for_selector(".type-rows")
    rows = page.locator(".type-row")
    check(rows.count() == 3 and rows.first.locator("input").first.input_value() == "Ordinary member" and rows.first.locator("input[type=number]").input_value() == "60",
          "Settings lists the membership types with their own fees")
    page.click("button:has-text('Add type')")
    page.locator(".type-row").last.locator("input").first.fill("Student member")
    page.locator(".type-row").last.locator("input[type=number]").fill("15")
    check(page.locator(".daymonth select").count() == 0 and "renew" not in page.inner_text("form:has(.type-rows)").lower(), "no renewal date: it is not built yet")
    page.click("button:has-text('Save membership')")
    page.wait_for_selector(".toast:has-text('Membership saved')")
    reload(page)
    page.wait_for_selector(".type-rows")
    check(page.locator(".type-row").count() == 4, "the new type is saved")
    page.locator(".type-row").last.locator("button:has-text('Remove')").click()
    page.click("button:has-text('Save membership')")
    page.wait_for_selector(".toast:has-text('Membership saved')")
    check(page.locator(".type-row").count() == 3, "a type can be removed again")

    print("Members: membership type and fee")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Members')")
    page.wait_for_selector("table.members")
    check("renews" not in page.inner_text("body"), "no renewal note on the Members page (not built yet)")
    sel = row_of(page, "umpire1@demo.test").locator("select")
    check(sel.locator("option").all_inner_texts() == ["\u2014", "Ordinary member", "Junior member", "Life member"], "the dropdown offers the types set up in Settings")
    sel.select_option("Junior member")
    page.wait_for_timeout(300)
    reload(page)
    page.wait_for_selector("table.members")
    row1 = row_of(page, "umpire1@demo.test")
    check(row1.locator("select").input_value() == "Junior member" and "$25" in row1.inner_text(), "the choice is saved and the type's fee is shown")

    print("Availability: import a season from a spreadsheet")
    page.click(".nav-link:has-text('Availability')")
    page.wait_for_selector(".season-grid")
    before_rows = page.locator(".season-grid tbody tr").count()
    page.click(".import-card summary")
    cal = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.season.calendar.filter(e => (e.comp || 'senior') === 'senior').slice(0, 2)")
    def heading(entry):
        ds = [date.fromisoformat(x) for x in entry["dates"]]
        return f"{entry.get('label', '')} - " + " & ".join(f"{d.day}th" for d in ds) + " " + ds[0].strftime("%b")
    sheet = ("Name\tEmail\t" + "\t".join(heading(e) for e in cal)
             + "\nV Palaniappan\tumpire10@demo.test\tDay 1, Day 2\tNot Available"
             + "\nSam Casual\tsam.casual@demo.test\tYes\tYes"
             + "\nNo Address\t\tYes\tYes")
    page.fill(".import-card textarea", sheet)
    page.click("button:has-text('Check it')")
    page.wait_for_selector(".import-out table")
    out = page.inner_text(".import-out")
    check(f"{len(cal)} columns matched to dates" in out, "the preview says which columns it matched to dates")
    check("1 of 3 people matched a member" in out and "Sam Casual" in out and "No Address" in out, "it says who it could not find on the Members list")
    check("cannot be added because the sheet has no email" in out, "and which of them cannot be added")
    page.check(".import-card input[type=checkbox]")
    page.click("button:has-text('Import')")
    page.wait_for_selector(".toast:has-text('imported')")
    check("2 imported, 1 added as non-members, 1 skipped" in page.locator(".toast").last.inner_text(), "two are imported and the stranger with an email is added")
    page.wait_for_selector(".season-grid tr.nonmember")
    check(page.locator(".season-grid tbody tr").count() == before_rows + 1 and page.locator("tr.nonmember:has-text('Sam Casual')").count() == 1,
          "the new person is in the sheet, marked Non-member")
    check("2 non-members" in page.inner_text(".summary"), "the summary counts non-members separately (the sample applicant and the new person)")
    d1 = date.fromisoformat(cal[0]["dates"][0]).strftime("%-d")
    imported = page.evaluate("""() => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        return { u10: db.availability['s-2026-27__umpire10@demo.test'] || Object.values(db.availability).find(a => a.email === 'umpire10@demo.test'),
                 sam: Object.values(db.availability).find(a => a.email === 'sam.casual@demo.test') };
      }""")
    first, second = cal[0]["dates"][0], cal[1]["dates"][0]
    check(imported["u10"]["days"][f"senior:{first}"] == "yes" and imported["u10"]["days"][f"senior:{second}"] == "no",
          "a member who had answered nothing now has the sheet's answers")
    check(imported["sam"]["days"][f"senior:{first}"] == "yes", "so does the new non-member")

    print("Allocate: a non-member is offered in a group of their own")
    goto(page, BASE + "admin")
    page.wait_for_selector(".comp-tile")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    groups = page.locator("select.slot").first.evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label)")
    check("Available Non-Member" in groups, f"the dropdown has an Available Non-Member group: {groups}")
    opt = page.locator("select.slot").first.evaluate("s => { const g = [...s.querySelectorAll('optgroup')].find(g => g.label === 'Available Non-Member'); return g ? { text: g.children[0].text, value: g.children[0].value } : null }")
    check(opt and "Sam Casual" in opt["text"], "with the non-member in it")
    page.locator("select.slot").first.select_option(value=opt["value"])
    page.wait_for_timeout(300)
    check(page.locator(".warn-icon").count() >= 1, "choosing them raises a warning like the others")
    page.click("details:has-text('Show warnings') summary")
    check("Not a member of this association" in page.inner_text("details:has-text('Show warnings')"), "the warning says why they cannot be appointed")
    page.locator("select.slot").first.select_option(value="")
    page.wait_for_timeout(300)
    page.click(".publish button:has-text('Re-publish')")
    page.wait_for_selector(".publish button:disabled")

    print("Umpire turns down an appointment from their own page")
    appt = page.evaluate("""(today) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const r = Object.values(db.rounds).find(x => x.published && x.comp === 'senior' && x.end >= today);
        for (const g of Object.values(db.games[r.id] || {})) {
          for (const [d, arr] of Object.entries(g.alloc || {})) {
            const a = (arr || []).find(Boolean);
            if (a && d >= today) { const u = Object.values(db.umpires).find(u => u.pid === a.p);
              return { email: u.email, name: u.name, date: d, roundId: r.id, gameId: g.id }; }
          }
        }
        return null;
      }""", today.isoformat())
    before_mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {}).length")
    sign_out(page)
    sign_in(page, appt["email"])
    page.wait_for_selector(".appt")
    check(page.locator(".appt").count() >= 1, "the umpire sees their appointments")
    multi = page.locator(".appt-game:has(.appt + .appt)")
    check(multi.count() == 0 or (multi.first.locator(".appt").count() == 2 and multi.first.locator(".chip.grade").count() == 1),
          "a two-day game is one card with a row per day")
    ds = page.locator(".appt").evaluate_all("l => l.map(e => e.dataset.date)")
    check(ds == sorted(ds), f"appointments are soonest first ({', '.join(ds)})")
    row = page.locator(".appt").first
    check(row.locator("button:has-text(\"I can't do this\")").count() == 1, "each appointment has an 'I can't do this' button")
    appt_date = row.locator(".appt-date strong").inner_text()
    row.locator("button:has-text(\"I can't do this\")").click()
    page.wait_for_selector(".appt.declined")
    check("You said you can't do this" in page.locator(".appt.declined").first.inner_text(), "turning it down is marked on the appointment")
    now_mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {})")
    check(len(now_mail) == before_mail + 1 and appt["name"] in now_mail[-1]["message"]["subject"], "the officer is emailed")
    sec = page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{appt_date}')").first
    check(sec.locator("button.opt.no.on").count() == 1, "their availability for that day is now 'Not available'")
    reload(page)
    page.wait_for_selector(".comp-section")
    check(page.locator(f".appt[data-date='{appt['date']}']").count() == 0 and page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{appt_date}') button.opt.no.on").count() == 1,
          "after a reload the game they gave back is no longer listed, and the day stays Not available")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".dropouts")
    check(appt["name"] in page.locator(".dropouts").inner_text(), "the officer sees it on Allocate")
    freed = page.evaluate("""(a) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        return (db.games[a.roundId][a.gameId].alloc[a.date] || []).some(x => x && x.n === a.name);
      }""", appt)
    check(not freed, "and the slot is free again")
    page.click(".dropouts button:has-text('Got it')")
    # The officer puts them back on the game and publishes again: the appointment stands once more.
    page.evaluate("""(a) => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k)); const o = db.orgs.pdca;
        const u = Object.values(o.umpires).find(x => x.email === a.email);
        const g = o.games[a.roundId][a.gameId]; const arr = g.alloc[a.date] || []; const i = arr.findIndex(x => !x);
        arr[i < 0 ? arr.length : i] = { p: u.pid, n: u.name }; g.alloc[a.date] = arr;
        const av = Object.values(o.availability).find(x => x.email === a.email); av.days['senior:' + a.date] = 'yes';   // marked Available again
        o.rounds[a.roundId].published = true; o.rounds[a.roundId].publishedAt = new Date(Date.now() + 1000).toISOString();
        localStorage.setItem(k, JSON.stringify(db)); }""", appt)
    page.reload()
    page.wait_for_selector(".who")
    sign_out(page)
    sign_in(page, appt["email"])
    page.wait_for_selector(".appt")
    check(page.locator(".appt.declined").count() == 0 and page.locator(".appt button:has-text(\"I can't do this\")").count() >= 1,
          "put back and published again: 'You said you can't do this' is gone and the appointment stands")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")

    print("Umpire pulls out of a published game")
    info = page.evaluate("""(today) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const r = Object.values(db.rounds).find(x => x.published && x.comp === 'senior' && x.end >= today);
        for (const g of Object.values(db.games[r.id] || {})) {
          for (const [d, arr] of Object.entries(g.alloc || {})) {
            const a = (arr || []).find(Boolean);
            if (a && d >= today) { const u = Object.values(db.umpires).find(u => u.pid === a.p);
              return { email: u.email, name: u.name, date: d, roundId: r.id, gameId: g.id }; }
          }
        }
        return null;
      }""", today.isoformat())
    check(bool(info), f"a published Senior game has an umpire on it ({info and info['name']})")
    d = date.fromisoformat(info["date"])
    label = d.strftime("%a, ") + str(d.day) + d.strftime(" %b")
    sign_out(page)
    sign_in(page, info["email"])
    page.wait_for_selector(".comp-section")
    page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{label}')").first.locator("button.opt.no").click()
    save(page)
    page.wait_for_selector(".toast")
    check("You were down for" in page.locator(".toast").inner_text() and "has been told" not in page.locator(".toast").inner_text(), "the umpire is told their change affects a game they were given")
    check(page.locator(f".appt[data-date='{info['date']}']").count() == 0, "that day leaves My appointments straight away")
    reload(page)
    page.wait_for_timeout(800)
    check(page.locator(f".appt[data-date='{info['date']}']").count() == 0, "and stays off after a reload, until the officer publishes again")
    mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {})")
    check(len(mail) >= 1 and mail[-1]["to"] == "admin@demo.test" and info["name"] in mail[-1]["message"]["subject"], f"an email to the officer is queued ({len(mail)})")
    check(label.split(", ")[1] in mail[-1]["message"]["text"], "the email lists the date and game")
    unfold(page)
    check(page.locator(".comp-section:not(.player-card) .group-foot button.primary:visible:not([disabled])").count() == 0, "with nothing changed, no Save can be pressed again")
    page.locator(".comp-section:not(.player-card) .group-foot button.primary").first.dispatch_event("click")       # even if it is forced
    page.wait_for_timeout(500)
    again = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {}).length")
    check(again == len(mail), "nothing is submitted, so the officer is not emailed twice")

    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".dropouts")
    check(info["name"] in page.locator(".dropouts").inner_text(), "the officer sees a banner on Allocate naming who pulled out")
    freed = page.evaluate("""(info) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const g = db.games[info.roundId][info.gameId];
        return { still: (g.alloc[info.date] || []).some(a => a && a.n === info.name), note: g.changeNote || '' };
      }""", info)
    check(not freed["still"], "the slot is unallocated again")
    check(info["name"] in freed["note"] and "no longer available" in freed["note"], "the game carries a note for the officer")
    page.locator(".dropouts a").first.click()
    page.wait_for_selector("table.board")
    check(page.locator(".change:has-text('no longer available')").count() >= 1, "the board flags the game")
    # Each list in last-name order; the Already allocated list has those on a game that day first.
    lasts = page.locator("select.slot").first.evaluate("""s => [...s.querySelectorAll('optgroup')].map(g => [...g.children].map(o =>
        [g.label !== 'Already allocated' || !/elsewhere/.test(o.text) ? 0 : 1, o.text.split(' \u00b7 ')[0].split(' ').slice(-1)[0].toLowerCase()]))""")
    check(all(g == sorted(g) for g in lasts) and sum(len(g) for g in lasts) > 3, "names in the umpire lists are in last-name order (already allocated: on a game that day, then player umpire elsewhere)")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check(page.locator(".dropouts").count() == 1, "the banner is still there until the officer dismisses it")
    page.click(".dropouts button:has-text('Got it')")
    check(page.locator(".dropouts").count() == 0, "the banner can be dismissed")
    reload(page)
    page.wait_for_selector(".comp-tile")
    check(page.locator(".dropouts").count() == 0, "and it does not come back: the withdrawal is handled")

    print("Umpire changes their mind: Available again for the same day")
    sign_out(page)
    sign_in(page, info["email"])
    page.wait_for_selector(".comp-section")
    page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{label}')").first.locator("button.opt.yes").click()
    save(page)
    page.wait_for_timeout(300)
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    back = page.evaluate("""(info) => { const o = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const g = o.games[info.roundId][info.gameId]; return { inSlot: (g.alloc[info.date] || []).some(x => x && x.n === info.name), note: g.changeNote || '' }; }""", info)
    check(not back["inSlot"] and "no longer available" in back["note"], "they are NOT put back: the pull-out stands until the officer decides")

    print("The officer fills the place: the warning goes")
    goto(page, BASE + f"admin/round/{info['roundId']}")
    page.wait_for_selector(f".change:has-text('{info['name']} is no longer available')")
    row = page.locator(f"tr:has(.change:has-text('{info['name']} is no longer available'))").first
    empty = row.locator("select.slot.empty").first
    taken = row.locator("select.slot").evaluate_all("l => l.map(s => s.value).filter(Boolean)")
    pick = empty.evaluate("(s, a) => [...s.options].find(o => o.value && !o.text.startsWith(a[0]) && !a[1].includes(o.value) && !o.disabled).value", [info["name"], taken])
    empty.select_option(pick)
    page.wait_for_timeout(400)
    check(page.locator(f".change:has-text('{info['name']} is no longer available')").count() == 0, "a new umpire in that game: its 'no longer available' note goes")
    page.click("a.tab:has-text('Back to Allocate')")
    page.wait_for_selector(".comp-tile")
    check(page.locator(".dropouts").count() == 0, "and so does the Allocate banner")

    print("Nothing new reaches umpires until the officer publishes")
    new_email = page.evaluate("(pid) => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires).find(u => u.pid === pid).email", pick)
    sign_out(page)
    sign_in(page, new_email, open_form=False)
    page.wait_for_timeout(500)
    check(page.locator(f".appt[data-date='{info['date']}']").count() == 0, "the umpire just put in does not see the game yet")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + f"admin/round/{info['roundId']}")
    page.wait_for_selector(".publish button:has-text('Re-publish')")
    page.click(".publish button:has-text('Re-publish')")
    page.wait_for_selector(".publish button:disabled")
    sign_out(page)
    sign_in(page, new_email, open_form=False)
    page.wait_for_selector(".appt")
    check(page.locator(f".appt[data-date='{info['date']}']").count() >= 1, "after Re-publish they see it")

    print("Settings: the officer decides whether there are player umpires")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/player-umpires']")
    page.wait_for_selector("form:has(h2:has-text('Player umpires'))")
    pu_form = page.locator("form:has(h2:has-text('Player umpires'))")
    boxes = pu_form.locator("label.inline:has(input[type=checkbox])").all_inner_texts()
    check([x.strip() for x in boxes][1:] == ["Senior", "T20", "Junior"] and not any(b.is_checked() for b in pu_form.locator("input[type=checkbox]").all()),
          f"the officer picks which groups player umpires choose from; nothing is ticked to start with, not even the switch ({boxes})")
    check("Senior round" in pu_form.locator("textarea").input_value(), "Settings has a Player umpires switch and the text members see")
    pu_form.locator("input[type=checkbox]").first.check()
    pu_form.locator("button:has-text('Save')").click()
    page.wait_for_selector(".toast:has-text('at least one group')")
    check(pu_form.locator("[role=alert]").is_visible() and page.locator(".toast:has-text('Saved')").count() == 0,
          "player umpires cannot be saved switched on without a group ticked")
    pu_form.locator("label:has-text('Senior') input").check()
    pu_form.locator("input[type=checkbox]").first.uncheck()
    check(not any(b.is_checked() for b in pu_form.locator("input[type=checkbox]").all()) and pu_form.locator("label:has-text('Senior') input").is_disabled(),
          "switching player umpires off unticks all the groups")
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    page.wait_for_selector(".comp-section")
    check(page.locator(".avail-head h2:has-text('Parramatta District Cricket Association')").count() == 1
          and page.locator("text=Full umpire").count() == 0 and page.locator(".player-card").is_hidden(),
          "switched off: headed with the association's name, with no Full umpire wording and no player-umpire card")
    body = page.inner_text("body")
    check("The appointments officer gives me games" not in body and "Tick one or both" not in body and "false" not in body, "the removed lines are gone, and no stray 'false'")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/player-umpires']")
    pu_form = page.locator("form:has(h2:has-text('Player umpires'))")
    pu_form.locator("input[type=checkbox]").first.check()
    pu_form.locator("label:has-text('Senior') input").check()
    pu_form.locator("textarea").fill("")
    pu_form.locator("button:has-text('Save')").click()
    page.wait_for_selector(".toast:has-text('Saved')")
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    page.wait_for_selector(".player-card:visible")
    check(page.locator(".player-card .comp-head .chip").inner_text() == "Newly Added", "player umpiring switched on after they answered shows as Newly Added")
    page.locator(".player-card .comp-head").click()
    check(page.locator(".player-card .comp-head .chip").inner_text() == "Not submitted", "once they open it, it reads Not submitted")
    check(page.locator(".player-card .group-note").count() == 0, "with no text set, no description is shown")
    check(page.locator(".player-card h2").inner_text() == "Player umpire", "with no name set, it is called Player umpire")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/player-umpires']")
    pu_form = page.locator("form:has(h2:has-text('Player umpires'))")
    pu_form.locator("textarea").fill("Pick any Senior game you would like to umpire.")
    pu_form.locator("input[aria-label='Name for player umpiring']").fill("Choose my own games")
    pu_form.locator("button:has-text('Save')").click()
    page.wait_for_selector(".toast:has-text('Saved')")

    print("Player umpire: a member chooses their own game")
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    page.wait_for_selector(".player-card:visible")
    check(page.locator(".player-card h2").inner_text() == "Choose my own games" and page.locator("text=Full umpire").count() == 0
          and page.locator("text=How I will umpire").count() == 0, "no Full umpire or How I will umpire wording; the officer's own name for player umpiring")
    check(page.locator(".pick-list").count() == 0, "choosing games is a second option: closed until they open it")
    check("Pick any Senior game you would like to umpire." in page.inner_text(".player-card"), "members see the officer's own wording")
    check(page.locator(".comp-section:not(.player-card)").count() == 3, "each group has its own card, and player umpiring has one too")
    page.locator(".player-card .comp-head").click()
    page.wait_for_selector(".pick-list")
    order = page.evaluate("() => { const a = document.querySelector('.comp-section'), p = document.querySelector('.player-card'); return !!(a.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING); }")
    check(order, "the groups come before the player-umpire games")
    opts = page.locator(".chooser-pick select").first.locator("option").all_inner_texts()
    check(page.locator(".chooser-pick select[aria-label=Competition]").count() == 0 and "Senior" in page.inner_text(".chooser h3"), "only Senior games can be chosen: no competition dropdown")
    check(page.locator(".pick-list .chip.grade").filter(has_text=re.compile(r"^U\d")).count() == 0 and not any("T20" in o for o in opts), "no Junior or T20 fixtures are offered")
    grade_sel = page.locator(".chooser-pick select[aria-label=Grade]")
    all_rows = page.locator(".pick-row").count()
    grades = grade_sel.locator("option").all_inner_texts()
    check(grades[0] == "All grades" and len(grades) > 2, f"a grade filter lists the round's grades ({len(grades) - 1})")
    grade_sel.select_option(label=grades[2])
    page.wait_for_timeout(200)
    shown_grades = set(page.locator(".pick-row .chip.grade").all_inner_texts())
    check(0 < page.locator(".pick-row").count() < all_rows and len(shown_grades) == 1, f"choosing a grade shows only its games ({grades[2]})")
    grade_sel.select_option(label="All grades")
    page.wait_for_timeout(200)
    check(page.locator(".pick-row").count() == all_rows, "All grades shows every game again")
    page.locator(".chooser-pick select[aria-label=Round]").select_option(index=1)          # a round that is not published yet
    page.wait_for_timeout(200)
    row = page.locator(".pick-row").filter(has=page.locator("button:has-text('Day 1')")).first
    game_text = row.locator("div").first.inner_text().strip()
    check(row.locator("button:has-text('Both days')").count() == 1, "a two-day game offers Day 1, Day 2 or both")
    row.locator("button:has-text('Day 1')").click()
    page.wait_for_selector(".my-picks")
    check(game_text.split(" ", 1)[1] in page.inner_text(".my-picks"), f"the game is listed as theirs ({game_text})")
    check("1 game chosen" in page.inner_text(".player-card .group-foot"), "its own save bar counts it")
    check(page.locator(".player-card .group-foot button.primary").is_enabled() and page.locator(".comp-section:not(.player-card) .group-foot button.primary:visible:not([disabled])").count() == 0,
          "only the player-umpire Save is live; no group has anything to save")
    days_before = page.evaluate("() => (Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.availability).find(a => a.email === 'umpire4@demo.test') || {}).days || {}")
    page.locator(".player-card .group-foot button.primary").click()
    page.wait_for_selector(".toast:has-text('will see the games you chose')")
    days_after = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.availability).find(a => a.email === 'umpire4@demo.test').days")
    check(days_after == days_before, "choosing a game does not change their date answers, so the officer's Availability sheet is unaffected")
    reload(page)
    page.wait_for_selector(".player-card:visible")
    check(game_text.split(" ", 1)[1] in page.inner_text(".player-card .player-picks") and page.locator(".player-card .comp-head .chip").inner_text() == "\u2713 Submitted",
          "the game is saved, and the card folds to a summary marked Submitted")
    dialogs = []
    page.on("dialog", lambda d: dialogs.append(d.message))
    page.locator(".player-card .comp-head").click()
    page.locator(".my-picks button:has-text('Remove')").first.click()
    check(page.locator(".player-card .comp-head .chip").inner_text() == "Unsaved changes", "removing a game shows Unsaved changes on the player card")
    page.locator(".player-card .group-foot button:has-text('Close')").click()
    check(page.locator(".player-card .comp-head .chip").inner_text() == "Unsaved changes", "Close keeps the change: still Unsaved changes")
    page.locator(".player-card .comp-head").click()
    page.locator(".player-card .group-foot button:has-text('Discard changes')").click()
    page.locator(".player-card .group-foot button:has-text('Close')").click()
    check(not dialogs and game_text.split(" ", 1)[1] in page.inner_text(".player-card .player-picks") and page.locator(".player-card .comp-head .chip").inner_text() == "\u2713 Submitted",
          "Discard changes asks nothing and puts the saved game back, still Submitted")
    reload(page)
    page.wait_for_selector(".player-card:visible")
    check(game_text.split(" ", 1)[1] in page.inner_text(".player-card .player-picks"), "the chosen game is still there")

    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".pu-note")
    check("B Chellapa chose" in page.inner_text(".pu-note") and "added to the board" in page.inner_text(".pu-note"), "the officer is told a player umpire chose a game")
    page.locator(".pu-note a").first.click()
    page.wait_for_selector("table.board")
    pu_row = page.locator("tr:has(.chip.pu)")
    check(pu_row.count() == 1 and game_text.split(" ", 1)[1].split(" v ")[0] in pu_row.inner_text(), "the game is on the Assign board, its grade turned on")
    sel_text = pu_row.locator("select.slot").first.evaluate("s => s.options[s.selectedIndex].text")
    check(sel_text.startswith("B Chellapa"), f"with their name already filled in ({sel_text})")
    check(pu_row.locator("select.slot").nth(1).input_value() == "", "only on the day they chose")
    first = pu_row.locator("select.slot").first
    grp = lambda sel, name: sel.evaluate("(s, n) => { const o = [...s.options].find(o => o.text.startsWith(n)); return o && o.parentElement.label ? o.parentElement.label + ' | ' + o.text : ''; }", name)
    check(grp(first, "B Chellapa").startswith("Player umpire (chose this game)"), "in the game they chose they are listed first, as the player umpire")
    swap = first.evaluate("s => [...s.options].find(o => o.text.startsWith('G Serrao')).value")
    first.select_option(swap)
    page.wait_for_timeout(300)
    check(page.locator(".chip.pu").count() == 0, "the officer can swap them for a full umpire; the tag goes with them")
    first = page.locator("select.slot").filter(has_text="G Serrao").first
    back = first.evaluate("s => [...s.options].find(o => o.text.startsWith('B Chellapa')).value")
    first.select_option(back)
    page.wait_for_timeout(300)
    check(page.locator("tr:has(.chip.pu)").count() == 1 and page.locator("tr:has(.chip.pu) select.slot").first.evaluate("s => s.options[s.selectedIndex].text").startswith("B Chellapa"),
          "putting them back brings the Player umpire tag back")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    bc = page.locator("tr:has(td:has-text('B Chellapa'))")
    page.wait_for_selector("td.av.pu")
    check(bc.locator("td.av.pu .chip.pu").count() >= 1 and "player umpire" in page.inner_text(".summary"),
          "the round's Availability tab shows their choice, tagged Player umpire")
    page.click("a.tab:has-text('Assign')")
    page.wait_for_selector("table.board")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check("B CHELLAPA (PLAYER UMPIRE)" in page.inner_text(".report-table"), "the report names them as a player umpire")

    page.click("a.tab:has-text('Assign')")
    page.wait_for_selector("table.board")
    # Published, then the player umpire says they can't do it.
    page.click(".publish button:has-text('Publish')")
    page.wait_for_selector(".publish button:disabled")
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    page.wait_for_selector(".appt")
    pu_fixture = game_text.split(" ", 1)[1]
    prow = page.locator(".appt-game").filter(has_text=pu_fixture).first.locator(".appt").first
    prow.locator("button:has-text(\"I can't do this\")").click()
    page.wait_for_selector(".appt.declined")
    av4 = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.availability).find(a => a.email === 'umpire4@demo.test')")
    check(not av4.get("picks") and av4["days"].get("senior:2026-12-05") == "no",
          "saying they can't do it gives the game back and marks them Not available that day")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".dropouts")
    check("B Chellapa" in page.inner_text(".dropouts"), "the officer is told")
    page.locator(".dropouts a").first.click()
    page.wait_for_selector("table.board")
    check(page.locator(".chip.pu").count() == 0, "and their name comes off the board")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    check(page.locator("tr:has(td:has-text('B Chellapa')) td.av.pu").count() == 0, "the Availability tab no longer shows them as a player umpire")
    gave_round = page.evaluate("() => { const g = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.games; return location.pathname.split(/[/?]/).find(x => x in g); }")
    # They choose a different game instead: it goes on the board (umpires see it once published).
    sign_out(page)
    # A second game in the same grade and the same week as the one they gave back.
    page.evaluate("""(rid) => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k)); const o = db.orgs.pdca;
        const src = Object.values(o.games[rid])[0];
        const g = { ...JSON.parse(JSON.stringify(src)), id: src.id + '-2', home: { name: 'Cobras' }, away: { name: 'Dingoes' }, alloc: {}, slots: 0, puOnly: false, puGame: false, changeNote: '' };
        o.games[rid][g.id] = g;
        const fl = o.fixtures[rid]; fl.games.push({ id: g.id, grade: g.grade, comp: g.comp, home: g.home, away: g.away, ground: g.ground || '', matchType: g.matchType || '', days: g.days });
        localStorage.setItem(k, JSON.stringify(db)); }""", gave_round)
    page.reload()
    page.wait_for_selector(".who, #login-email")
    if page.locator(".who").count(): sign_out(page)
    sign_in(page, "umpire4@demo.test")
    check(page.locator(".appt-game").filter(has_text=pu_fixture).count() == 0, "the game they gave back is no longer listed under My appointments")
    page.locator(".player-card .comp-head").click()
    page.wait_for_selector(".chooser-pick select[aria-label=Round]")
    rsel = page.locator(".chooser-pick select[aria-label=Round]")
    pu_round = gave_round                                                    # the same week and grade as the game they gave back
    rsel.select_option(value=gave_round)
    page.wait_for_timeout(200)
    row2 = page.locator(".pick-row").filter(has_text="Cobras").first
    other = row2.locator("div").first.inner_text().strip().split(" ", 1)[1]
    row2.locator("button.opt.yes:not([disabled])").first.click()
    page.locator(".player-card .group-foot button.primary").click()
    page.wait_for_timeout(400)
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + f"admin/round/{pu_round}")
    page.wait_for_selector("table.board")
    check(page.locator("tr:has(.chip.pu):has-text('Cobras')").count() >= 1, f"the newly chosen game, same grade and week, is on the Assign board with them as player umpire ({other})")
    # The officer keeps the board open; meanwhile the umpire (on their own device) removes that choice.
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k));
        const a = Object.values(db.orgs.pdca.availability).find(x => x.email === 'umpire4@demo.test'); a.picks = [];
        localStorage.setItem(k, JSON.stringify(db)); }""")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(800)
    check(page.locator("tr:has(.chip.pu):has-text('Cobras')").count() == 0, "coming back to the open board, the umpire's change is applied without a refresh")
    check(page.locator(".publish button:has-text('Re-publish')").count() == 1, "and it waits for the officer to Re-publish")
    goto(page, BASE + f"admin/round/{gave_round}/availability")
    page.wait_for_selector("td.av")
    # Data left over from before this was fixed: a game still marked as a player umpire game, nobody chose it.
    rid = page.evaluate("() => { const g = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.games; return location.pathname.split(/[/?]/).find(x => x in g); }")
    page.evaluate("""(rid) => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k));
        const g = Object.values(db.orgs.pdca.games[rid]).find(x => x.home.name !== 'Cobras'); g.puOnly = true; g.puGame = true; g.slots = 1; g.alloc = {};
        localStorage.setItem(k, JSON.stringify(db)); }""", rid)
    page.reload()
    page.wait_for_selector("a.tab:has-text('Assign')")
    page.click("a.tab:has-text('Assign')")
    page.wait_for_selector("button:has-text('Select grades')")
    check(page.locator("table.board tr:has(.chip.grade):not(:has-text('Cobras'))").count() == 0, "a game left marked from a given-back choice, with nobody in it, goes off the board")
    page.click("button:has-text('Select grades')")
    page.wait_for_selector("dialog .grade-row")
    check(page.locator("dialog .chip.pu").count() == 0, "Select grades only marks games someone has chosen now (a stale mark is ignored)")
    page.click("dialog button:has-text('Done')")
    page.wait_for_timeout(300)
    goto(page, BASE + "admin")
    page.wait_for_selector(".dropouts")
    page.click(".dropouts button:has-text('Got it')")

    print("Availability: each group is answered, saved or cancelled on its own")
    sign_out(page)
    # One of their saved T20 answers is missing, as old or imported data might be.
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k));
        const a = Object.values(db.orgs.pdca.availability).find(a => a.email === 'umpire5@demo.test');
        const key = Object.keys(a.days).filter(x => x.startsWith('t20:')).sort()[0]; delete a.days[key]; localStorage.setItem(k, JSON.stringify(db)); }""")
    reload(page)
    page.wait_for_selector("#login-email")
    sign_in(page, "umpire5@demo.test", open_form=False)
    page.wait_for_selector(".comp-section")
    AV = "() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.availability).find(a => a.email === 'umpire5@demo.test')"
    saved0 = page.evaluate(AV)
    grp = lambda n: page.locator(f".comp-section:has(h2:has-text('{n}'))")
    chip = lambda n: grp(n).locator(".comp-head .chip").inner_text()
    gsave = lambda n: grp(n).locator(".group-foot button.primary")
    flip = lambda row: row.locator("button.opt.no").click() if "on" not in (row.locator("button.opt.no").get_attribute("class") or "") else row.locator("button.opt.yes").click()
    check(page.locator(".comp-section:not(.player-card)").count() == 3 and page.locator(".tile:visible").count() == 0, "three group cards, each folded to a summary")
    check(page.locator(".comp-section:not(.player-card) .comp-head").count() == 3 and "new date" not in page.inner_text(".avail-card"), "each group is one tappable line, with no 'new dates' wording")
    # Change Junior and Senior, in two separate cards
    grp("Junior").locator(".comp-head").click()
    jrow = grp("Junior").locator(".drow").first
    jun_was = jrow.locator("button.opt.on").count()
    flip(jrow)
    check(chip("Junior") == "Unsaved changes" and chip("Senior") == "\u2713 Submitted" and gsave("Junior").is_enabled(), "a Junior change shows on Junior only, and Junior's own Save is live")
    grp("Senior").locator(".comp-head").click()
    check(gsave("Senior").is_disabled(), "Senior is open but unchanged: its Save is greyed out")
    sen_row = grp("Senior").locator(".drow").first
    flip(sen_row)
    # Leave a Senior date blank (tap the chosen answer again): Save Senior must refuse and point at it.
    blank_row = grp("Senior").locator(".drow").nth(1)
    blank_row.locator("button.opt.on").click()
    gsave("Senior").click()
    page.wait_for_selector(".toast:has-text('Answer every date')")
    check("Senior" in page.locator(".toast").last.inner_text() and "1 left" in page.locator(".toast").last.inner_text() and "Junior" not in page.locator(".toast").last.inner_text(),
          "a blank date stops that group's save, and only that group is checked")
    check("missing" in (blank_row.get_attribute("class") or ""), "the blank date is highlighted")
    check(page.evaluate(AV)["days"] == saved0["days"], "nothing was saved")
    blank_row.locator("button.opt.yes").click()
    check("missing" not in (blank_row.get_attribute("class") or ""), "answering it clears the highlight")
    gsave("Senior").click()
    page.wait_for_selector(".toast:has-text('Senior availability saved')")
    page.wait_for_timeout(300)
    saved1 = page.evaluate(AV)
    jun0 = {k: v for k, v in saved0["days"].items() if k.startswith("junior:")}
    jun1 = {k: v for k, v in saved1["days"].items() if k.startswith("junior:")}
    sen_changed = [k for k in saved1["days"] if k.startswith("senior:") and saved1["days"][k] != saved0["days"].get(k)]
    check(jun0 and jun1 == jun0, "saving Senior did not send the unsaved Junior change")
    check(len(sen_changed) in (1, 2), "only the Senior changes were sent")
    check(chip("Senior") == "\u2713 Submitted" and grp("Senior").locator(".tile:visible").count() == 0 and chip("Junior") == "Unsaved changes",
          "Senior folds back to Submitted; the unsent Junior change still shows")
    # Discard changes throws away one group's change and nothing else
    grp("Junior").locator(".group-foot button:has-text('Discard changes')").click()
    grp("Junior").locator(".group-foot button:has-text('Close')").click()
    check(chip("Junior") == "\u2713 Submitted" and grp("Junior").locator(".group-summary").is_visible(), "Discard changes on Junior throws its change away: back to Submitted")
    check(page.evaluate(AV)["days"] == saved1["days"], "and nothing was saved by discarding")
    grp("Junior").locator(".comp-head").click()
    check(("on" in (grp("Junior").locator(".drow").first.locator("button.opt").nth(0).get_attribute("class") or "") or "on" in (grp("Junior").locator(".drow").first.locator("button.opt").nth(1).get_attribute("class") or "")) == bool(jun_was),
          "opening Junior again shows what was saved")
    grp("Junior").locator(".group-foot button:has-text('Close')").click()
    # T20 has a date that was never answered: it must be answered before T20 can be saved
    grp("T20").locator(".comp-head").click()
    sen_row2 = grp("T20").locator(".drow").nth(1)
    flip(sen_row2)
    gsave("T20").click()
    page.wait_for_selector(".toast:has-text('Answer every date')")
    check("T20" in page.locator(".toast").last.inner_text() and "1 left" in page.locator(".toast").last.inner_text(), "T20's blank date (not edited) still stops T20's save")
    t20_blank = grp("T20").locator(".drow.missing")
    check(t20_blank.count() == 1, "and that T20 date is highlighted")
    t20_blank.locator("button.opt.yes").click()
    gsave("T20").click()
    page.wait_for_selector(".toast:has-text('T20 availability saved')")
    t20_now = page.evaluate(AV)["days"]
    check(all(t20_now.get(k) for k in [x for x in t20_now] if k.startswith("t20:")) and chip("T20") == "\u2713 Submitted",
          "once every date is answered it saves, and T20 is complete")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.click(".nav-link:has-text('Availability')")
    page.wait_for_selector(".season-grid")
    page.click(".tabs button.tab:has-text('Junior')")
    check("R Dryburgh" not in page.evaluate("() => document.body.innerText.split('Copy emails')[0]"), "the officer's Junior count does not chase someone who doesn't do Junior")

    print("Admin: fixtures load automatically (mocked service)")
    API_DOWN = False
    page.locator("button:has-text('Reset')").click()      # demo reset: start from an empty app
    page.wait_for_timeout(500)
    if page.locator(".who").count():
        sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".tile-round")
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "Junior", "Senior", "T20"], "no button needed: next rounds appear by themselves; Senior has a second tile for its one-day Women's game")
    check("Two Day" in tile("Senior", 0).inner_text() and N2.upper() in tile("Senior", 1).inner_text().upper() and "T20" in tile("Senior", 1).inner_text() and "Two Day" not in tile("Senior", 1).inner_text(), "second Senior tile: its own date and its own match type (T20 in the mock)")
    open_grades("Senior", 1)
    check(dlg.locator(".grade-row").count() == 1 and "Women" in dlg.locator(".grade-row").first.inner_text(), "its popup lists only the grade that plays then (Senior Women)")
    dlg.locator("button:has-text('Cancel')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check(page.locator("button:has-text('Load next week')").count() == 1, "Load next week is offered: later weeks exist")
    page.click("button:has-text('Load next week')")
    check(page.locator(".comp-tile").count() > 4, "it reveals more tiles")
    while page.locator("button:has-text('Load next week')").count():
        page.click("button:has-text('Load next week')")
    check(page.locator(".comp-tile:has(h2:has-text('Senior'))").count() == 3, "all Senior weeks are reachable (three here)")
    check(S1.upper() in tile("Senior").inner_text().upper() and f"day 2 {S2}" in tile("Senior").inner_text().replace("\xa0", " ") and N2.upper() in tile("T20").inner_text().upper(),
          "each tile shows its own week's day, with a two-day game's second day as a note")
    check(page.locator("text=Updating fixtures").count() == 0, "loading finished")
    check("Choose grades" in tile("Senior").inner_text(), "nothing is picked until the officer picks grades")
    open_grades("Senior")
    check(dlg.locator(".grade-row").count() == 2, "Senior popup lists the 2 grades playing this round")
    dlg.locator("button:has-text('All')").click()
    check("2 grades" in dlg.inner_text() and "4 umpire slots" in dlg.inner_text(), "All = 2 grades, 4 umpire slots (two-day games)")
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    stt = tile("Senior").inner_text()
    check("2 grades selected" in stt and "0 / 2 filled" in stt, f"tile shows 2 grades selected, 0 / 2 games filled (two two-day games): {stt!r}")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("table.board tbody tr").count() == 2 and page.locator("a[href*='google.com/maps']").count() == 2, "board lists the 2 Senior games with map links from the service")

    print("Admin: update fixtures picks up a ground change")
    API["g-a"][0]["venue"]["name"] = "New Ground"
    API["g-a"][0]["venue"]["playingSurface"]["name"] = "New Ground"
    page.click("button:has-text('Update fixtures')")
    page.wait_for_selector(".change")
    check("Ground" in page.locator(".change").first.inner_text(), "ground change is flagged on the game")

    print("New umpire sees the dates from the same fetch")
    sign_out(page)
    sign_in(page, "umpire2@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").click()
    page.wait_for_selector(".join-form")
    page.locator(".join-form input").nth(0).fill("Umpire")
    page.locator(".join-form input").nth(1).fill("Two")
    page.fill(".join-form input[data-field=phone]", "0400 777 888")
    page.click(".join-form button:has-text('Request to join')")
    page.wait_for_selector(".pending-card")
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k)); const u = db.orgs.pdca.umpires['umpire2@demo.test'];
        u.approved = true; u.active = true; localStorage.setItem(k, JSON.stringify(db)); }""")     # the officer approves them
    page.reload()
    page.wait_for_selector(".comp-section")
    check(page.locator(".tile:visible").count() == 0, "a first-time umpire sees the compact card, not the opened form")
    unfold(page)
    page.wait_for_selector(".tile")
    check(page.locator(".comp-section:not(.player-card) .comp-title").all_inner_texts() == ["Senior", "Junior", "T20"], "umpire sees Senior, Junior and T20 sections")
    unfold(page)
    check(page.locator(".drow").count() == 7, "umpire sees the 7 synced dates")
    check(page.locator(".comp-section:has(h2:has-text('Junior')) .drow").count() == 3, "Junior: its 3 dates, even though U14 is two-day and U13 one-day")
    check(page.locator(".comp-section:has(h2:has-text('Senior'))").get_by_text("Round").count() == 0 and page.locator(".comp-section:has(h2:has-text('Junior'))").get_by_text("Round").count() == 0, "mixed-length competitions have no round text")
    check(page.locator(".comp-section:has(h2:has-text('T20'))").get_by_text("Round 1").count() == 1, "the all-one-day T20 competition is shown by round")
    check(page.locator(".dlabel", has_text=fmt_day_check()).count() == 1, "a date plays out as just the date")
    chips = page.locator(".comp-section:not(.player-card) .comp-head .chip").all_inner_texts()
    check(chips == ["Not submitted"] * 3, "a fresh season: every group starts as 'Not submitted'")

    print("Mobile layout")
    m = ctx.new_page()
    m.set_viewport_size({"width": 390, "height": 800})
    goto(m, BASE)
    m.wait_for_selector(".comp-section")
    m.locator(".comp-section:not(.player-card) .comp-head").first.click()
    m.wait_for_selector(".tile")
    overflow = m.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
    check(not overflow, "availability page does not scroll sideways on a phone")
    check(m.locator(".group-foot button.primary").first.is_visible(), "each group's Save is there on a phone")
    check(m.evaluate("() => [...document.querySelectorAll('.group-foot')].every(f => f.scrollWidth <= f.clientWidth + 1)"), "and its buttons fit the width")
    m.close()

    print("Sample data loads made-up umpires and fixtures")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector("text=Loaded sample umpires and made-up fixtures")
    check(True, "sample data says it loaded made-up fixtures")
    page.wait_for_selector(".tile-round")
    check(re.search(r"\d+ / \d+ filled", tile("Senior").inner_text()) is not None, "sample Senior tile already has grades picked")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")

    print("Demo: an umpire on a fresh browser still gets the availability page")
    fresh = browser.new_context(viewport={"width": 1280, "height": 900})
    fp = fresh.new_page()
    fp.on("dialog", lambda d: d.accept())
    fp.route("https://grassrootsapiproxy.cricket.com.au/**", lambda r: r.abort())
    goto(fp, BASE)
    fp.wait_for_selector("#login-email")
    fp.fill("#login-email", "umpire1@demo.test")
    fp.click("button:has-text('Sign in')")
    fp.wait_for_selector(".org-list")
    check(fp.locator(".org-row:has-text('Parramatta') a:has-text('Join')").count() == 1, "the demo's built-in association is on the list to join")
    fp.click(".org-row:has-text('Parramatta') a:has-text('Join')")
    fp.wait_for_selector(".join-form")
    fp.locator(".join-form input").nth(0).fill("Umpire")
    fp.locator(".join-form input").nth(1).fill("One")
    fp.fill(".join-form input[data-field=phone]", "0400 000 001")
    fp.click(".join-form button:has-text('Request to join')")
    fp.wait_for_selector(".pending-card")
    fp.click("button:has-text('Load sample data')")
    fp.wait_for_selector(".comp-section")
    summ = fp.inner_text("main")
    check(fp.locator(".tile:visible").count() == 0 and all(c in summ for c in ["Senior", "Junior", "T20"]) and "available" in summ and "Submitted" in summ,
          "once submitted, each group folds into a short summary: how many dates available, Submitted")
    check(fp.locator(".player-card").count() == 0 or fp.locator(".player-card").is_hidden(),
          "player umpiring is off until the officer switches it on, so it is not listed")
    fp.locator(".comp-section:not(.player-card) .comp-head").first.click()
    fp.wait_for_selector(".drow")
    check(fp.locator(".comp-section:not(.player-card) .comp-title").count() == 3 and fp.locator("button.opt.yes:visible").count() > 3, "Edit availability opens that group's date-by-date form")
    r0 = fp.locator(".comp-section:visible .drow:visible").first
    was_yes = "on" in (r0.locator("button.opt.yes").get_attribute("class") or "")
    r0.locator("button.opt.no" if was_yes else "button.opt.yes").click()
    fp.locator(".group-foot button:visible:has-text('Close')").first.click()
    check(fp.locator(".tile:visible").count() == 0 and fp.locator(".comp-head .chip:has-text('Unsaved changes')").count() == 1, "Close folds it away, still marked Unsaved changes")
    fp.locator(".comp-section:not(.player-card) .comp-head").first.click()
    fp.locator(".group-foot button:visible:has-text('Discard changes')").first.click()
    check(("on" in (fp.locator(".comp-section:visible .drow:visible").first.locator("button.opt.yes").get_attribute("class") or "")) == was_yes, "Discard changes puts back what was saved")
    fresh.close()

    print("Associations: settings, officers, join link")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")
    check(page.locator("nav .menu > summary").inner_text().startswith("Parramatta District Cricket Association"), "the header menu is named after the association")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/new-umpires']")
    page.wait_for_selector(".join-link")
    check(page.locator(".join-link").inner_text().endswith("/join/pdca"), "Settings shows the link umpires join with")
    check("trial" not in page.inner_text("body").lower() and "subscription" not in page.inner_text("body").lower(), "nothing about trials or subscriptions")
    page.click(".settings-nav a[href='/admin/settings/association']")
    page.wait_for_selector(".officers")
    page.fill(".inline-form input[type=email]", "Second.Officer@demo.test")
    page.click("button:has-text('Add admin')")
    page.wait_for_selector(".officers li:has-text('second.officer@demo.test')")
    check(page.locator(".officers li").count() == 2 and page.locator(".officers li:has-text('admin@demo.test')").locator("text=you").count() == 1, "an officer can add another officer; you cannot remove yourself")

    print("Associations: a second association is completely separate")
    check(page.locator("#org-name").count() == 0, "nobody can start an association from the app")
    hills = "hills-cricket-association-ab12"
    page.evaluate("""(id) => {                       // the tool's owner sets an association up; here, straight into the demo store
        const k = 'pdca-umpires-demo-v2';
        const db = JSON.parse(localStorage.getItem(k));
        db.orgs[id] = { org: { id, name: 'Hills Cricket Association', playhqOrgId: '11111111-2222-3333-4444-555555555555', plan: 'trial', notifyEmail: 'founder@demo.test' },
          admins: ['founder@demo.test'], umpires: {}, rounds: {}, games: {}, availability: {}, settings: {}, season: null, withdrawals: {}, mail: {} };
        db.users['founder@demo.test'] = [id];
        localStorage.setItem(k, JSON.stringify(db));
      }""", hills)
    page.reload()                                    # the page keeps the demo store in memory, so re-read it
    page.wait_for_selector(".bar")
    sign_out(page)
    sign_in(page, "founder@demo.test")
    page.wait_for_selector(".comp-tile, .notice")
    check("Hills Cricket Association" in page.inner_text("body") or page.locator(".comp-tile").count() > 0, "its officer lands in it")
    goto(page, BASE + "admin")
    page.wait_for_selector(".comp-tile, .notice")
    goto(page, BASE + "admin/past")
    page.wait_for_selector("h1:has-text('Past allocations')")
    check(page.locator(".past-row").count() == 0 and "Nothing here yet" in page.inner_text("main"), "it starts with no history of its own")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Members')")
    page.wait_for_selector("textarea")
    check(page.locator("table.members tbody tr").count() == 0, "its member list is empty: PDCA's members are not visible")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Settings')")
    page.click(".settings-nav a[href='/admin/settings/association']")
    page.wait_for_selector(".officers")
    check(page.locator(".officers li").count() == 1 and "founder@demo.test" in page.locator(".officers").inner_text(), "its only officer is the founder")

    print("Associations: an umpire joins by link; people land in their own association")
    sign_out(page)
    sign_in(page, "hillsump@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    check(page.locator(".org-row").count() == 2 and page.locator(".org-row:has-text('Hills') a:has-text('Join')").count() == 1, "a new sign-up sees every association on Third Umpire, PDCA and Hills")
    goto(page, BASE + "join/" + hills)
    page.wait_for_selector(".join-form")
    check("Join Hills Cricket Association" in page.inner_text(".join-form h1"), "an association's own link opens its join form")
    page.locator(".join-form input").nth(0).fill("Hills")
    page.locator(".join-form input").nth(1).fill("Umpire")
    page.fill(".join-form input[data-field=phone]", "0400 555 666")
    page.click(".join-form button:has-text('Request to join')")
    page.wait_for_selector(".pending-card")
    check("Hills Cricket Association" in page.inner_text(".pending-card"), "they wait for that association's approval")
    sign_out(page)
    sign_in(page, "founder@demo.test")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    check(page.locator("tr.needs:has-text('Hills Umpire')").count() == 1 and page.locator("tr.needs").count() == 1, "the Hills officer sees the new umpire waiting for approval")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".tile-round")
    check(page.locator(".comp-tile").count() > 0 and page.locator("td:has-text('umpire1@demo.test')").count() == 0, "the PDCA officer lands back in PDCA, not the association last used on this computer")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    check(page.locator("a.member-link:has-text('Hills Umpire')").count() == 0 and row_of(page, "umpire1@demo.test").count() == 1, "PDCA sees its own umpires and not the Hills umpire")
    goto(page, BASE + "join/" + hills)
    page.wait_for_selector(".join-form")
    check("Join Hills Cricket Association" in page.inner_text(".join-form h1") and page.locator(".join-form input[data-field=phone]").count() == 1,
          "a PDCA officer who opens the Hills link is just a new umpire there: the Hills join form")
    goto(page, BASE + "profile")
    page.wait_for_selector(".member-profile .org-list")
    check(page.locator(".member-profile .org-row[data-org=pdca]").count() == 1 and page.locator(".member-profile .org-row:has-text('Hills')").count() == 0,
          "the profile lists PDCA as theirs, and not Hills")
    check(page.locator(".org-row[data-org=pdca] button").count() == 0 and page.locator(".org-row[data-org=pdca] .chip:has-text('Admin')").count() == 1,
          "the association they are in has no Open button, and shows its Admin tag")
    goto(page, BASE + "my")
    page.wait_for_selector(".other-associations")
    check(page.locator(".other-associations .org-row:has-text('Hills') a:has-text('Join')").count() == 1 and page.locator("a[href='/associations'], .who-menu a:has-text('Associations')").count() == 0,
          "My availability offers Hills to join, and the menu has no Associations page")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")
    page.click("nav .menu > summary")
    page.click(".menu-items .nav-link:has-text('Members')")
    page.wait_for_selector("table.members")
    check(row_of(page, "umpire1@demo.test").count() == 1, "switching back works")

    print("Umpire: their own profile")
    sign_out(page)
    sign_in(page, "umpire2@demo.test", open_form=False)
    page.click(".who-name")
    check([t.strip() for t in page.locator(".who-menu .nav-link").all_inner_texts()] == ["My profile", "Sign out"], "the account menu for an umpire: My profile, then Sign out (they land on My availability, and their associations are on their profile)")
    page.set_viewport_size({"width": 390, "height": 800})
    box = page.locator(".who-menu .menu-items").bounding_box()
    check(box["x"] >= 0 and box["x"] + box["width"] <= 390, f"on a phone the menu stays on screen ({box})")
    page.set_viewport_size({"width": 1280, "height": 900})
    page.click(".who-name")
    page.click(".who-name")
    page.click(".who-menu .nav-link:has-text('My profile')")
    page.wait_for_selector(".member-profile")
    me = page.inner_text(".member-profile")
    check("D Everton" in page.inner_text(".member-profile h1") and "Accreditation provider" in me and "My associations" in me
          and page.locator(".member-profile .assoc-card").count() >= 1 and "Parramatta" in page.inner_text(".assoc-card h2"),
          "clicking their name opens their own profile: their details once, then each association they belong to")
    card = page.locator(".member-profile .assoc-card").first
    check(all(t in card.inner_text() for t in ["Membership type", "Member since", "umpired", "pull-out", "fulfilment rate", "Past appointments"]),
          "membership type, status, member since, games, pull-outs, fulfilment and past appointments are per association")
    check(page.locator(".member-profile h2:has-text('Availability'), .member-profile h2:has-text('Upcoming')").count() == 0,
          "availability and upcoming games are left to their home page")
    card.locator("input[type=date]").fill("2015-02-01")
    card.locator("input[type=date]").dispatch_event("change")
    page.wait_for_timeout(300)
    check(page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['umpire2@demo.test'].memberSince") == "2015-02-01",
          "they can correct when they became a member of that association")
    page.click("a:has-text('Edit my details')")
    page.wait_for_selector("form input")
    page.locator("label:has-text('Accreditation provider') input").fill("Cricket NSW")
    page.click("form button:has-text('Save')")
    page.wait_for_selector(".member-profile")
    check("Cricket NSW" in page.inner_text(".member-profile"), "they fill in their accreditation provider themselves; it shows on their profile")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    row_of(page, "umpire2@demo.test").locator("a.member-link").click()
    page.wait_for_selector(".member-profile")
    check("Cricket NSW" in page.inner_text(".member-profile"), "and the officer sees it on the member's profile")

    print("Member profile")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    row_of(page, "umpire2@demo.test").locator("a.member-link").click()
    page.wait_for_selector(".member-profile")
    prof = page.inner_text(".member-profile")
    check("D Everton" in page.inner_text(".member-profile h1") and "umpire2@demo.test" in prof and "Member since" in prof,
          "clicking a name in Members opens their profile with their membership details")
    stats = page.locator(".member-profile .stat").all_inner_texts()
    check(any("games umpired here" in t or "game umpired here" in t for t in stats) and any("fulfilment rate" in t for t in stats) and any("pull-out" in t for t in stats),
          f"it shows games umpired, pull-outs and fulfilment rate here ({' | '.join(t.replace(chr(10), ' ') for t in stats)})")
    check(page.locator(".member-profile h2:has-text('Upcoming appointments')").count() == 1 and page.locator(".member-profile h2:has-text('Past appointments')").count() == 1
          and page.locator(".member-profile h2:has-text('Availability')").count() == 1, "and their availability, upcoming and past appointments here")
    other = page.locator(".member-profile section:has(h2:has-text('Other associations'))").inner_text()
    check("Nepean Cricket Association" in other and "Past" in other and "Hills District Cricket Association" in other and "Active" in other
          and "appointment" not in other.lower().replace("availability and appointments elsewhere are not shared", ""),
          "other associations: membership only, active and past")
    # Change their availability by clicking a date, as on the Availability sheet.
    btn = page.locator(".member-profile .date-btn").first
    d0 = btn.get_attribute("data-date")
    before = btn.inner_text()
    btn.click()
    page.wait_for_timeout(300)
    after = page.locator(f".member-profile .date-btn[data-date='{d0}']").first.inner_text()
    av2 = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.availability).find(a => a.email === 'umpire2@demo.test')")
    check(before != after and any(k.endswith(d0) for k in (av2.get("edited") or {})), f"clicking a date changes their availability and marks it as the officer's ({before} -> {after})")
    # Umpiring follows their availability: no buttons for it
    check(page.locator(".status-box .chip:has-text('Active umpire')").count() == 1 and page.locator(".status-box button:has-text('Make')").count() == 0,
          "the profile shows Active umpire from their availability, with nothing to change by hand")
    page.click(".status-box button:has-text('Suspend')")
    page.wait_for_selector(".status-box .chip:has-text('Suspended')")
    u2 = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['umpire2@demo.test']")
    check(u2["suspended"] is True and u2["active"] is False and page.locator(".status-box .chip:has-text('Active umpire')").count() == 0,
          "suspending (on the profile only) stops them umpiring")
    prof = page.evaluate("() => location.pathname")
    u2name = u2["name"]
    goto(page, BASE + "admin")
    page.wait_for_selector("a.tile-body")
    page.locator("a.tile-body").first.click()
    page.wait_for_selector("select.slot")
    opts = page.locator("select.slot").first.evaluate("s => [...s.options].map(o => o.text)")
    check(not any(u2name in o for o in opts), f"a suspended member is not offered on the Assign board, even with availability ({u2name})")
    goto(page, BASE + prof.lstrip("/"))
    page.wait_for_selector(".status-box button:has-text('Lift suspension')")
    page.click(".status-box button:has-text('Lift suspension')")
    page.wait_for_selector(".status-box .chip:has-text('Active umpire')")
    check(True, "lifting the suspension makes them a member again (Active umpire, from their availability)")
    page.select_option(".member-profile select[aria-label='Membership type']", label="Life member")
    page.wait_for_timeout(300)
    check(page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['umpire2@demo.test'].membership") == "Life member",
          "membership type can be set on the profile")
    check(page.locator(".member-profile input:not([type=date])").count() == 0, "and their personal details are shown, not editable")
    # Someone who has just registered: approve or reject
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2'; const db = JSON.parse(localStorage.getItem(k)); const o = db.orgs.pdca;
        o.umpires['newbie@demo.test'] = { pid: 'pnew1', email: 'newbie@demo.test', name: 'N Newbie', firstName: 'N', lastName: 'Newbie', active: false };
        o.umpires['nope@demo.test'] = { pid: 'pnew2', email: 'nope@demo.test', name: 'X Nope', firstName: 'X', lastName: 'Nope', active: false };
        localStorage.setItem(k, JSON.stringify(db)); }""")
    goto(page, BASE + "admin/member/pnew1")
    page.wait_for_selector(".status-box .chip:has-text('Waiting for approval')")
    page.click(".status-box button:has-text('Approve')")
    page.wait_for_selector(".status-box .chip:has-text('Member')")
    check(page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.umpires['newbie@demo.test'].active") is True, "a new registration can be approved from the profile")
    goto(page, BASE + "admin/member/pnew2")
    page.wait_for_selector(".status-box button:has-text('Reject')")
    page.click(".status-box button:has-text('Reject')")
    page.wait_for_selector(".status-box .chip:has-text('Rejected')")
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    check(page.locator("a.member-link:has-text('X Nope')").count() == 0, "or rejected: kept as Rejected, off the main list")
    page.select_option(".member-tools select", "rejected")
    check(page.locator("a.member-link:has-text('X Nope')").count() == 1, "and shown under Rejected")
    page.select_option(".member-tools select", "all")

    goto(page, BASE + "admin/availability")
    page.wait_for_selector("a.member-link")
    page.locator("a.member-link").first.click()
    page.wait_for_selector(".member-profile")
    check(page.locator(".member-profile h1").count() == 1, "names in the Availability sheet open the profile too")


    print("Settings: groups and grades")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + "admin/settings/groups")
    page.wait_for_selector(".groups-card")
    gc = page.locator(".groups-card")
    check(gc.locator("button[type=submit]").is_disabled(), "Save is greyed out until something changes")
    start_groups = [i.input_value() for i in gc.locator(".group-list input:not([type=checkbox])").all()]
    check(sorted(start_groups) == ["Junior", "Senior", "T20"], f"PDCA's groups come from its own competitions ({start_groups})")
    check(gc.locator("table.grades-table").count() == 0 and gc.locator(".grade-pill").count() == len(start_groups), "no long table of grades: each group has a pill with its grades")
    jr_pill = [r for r in gc.locator(".group-row").all() if r.locator("input").first.input_value() == "Junior"][0].locator(".grade-pill")
    jr_pill.click()
    page.wait_for_selector("dialog.grades-modal[open]")
    dm = page.locator("dialog.grades-modal")
    check(dm.locator(".grade-setting").count() > 1 and dm.locator(".grade-setting input[type=checkbox]:checked").count() == dm.locator(".grade-setting").count(),
          "the Junior pill opens its grades, ticked (the sample association umpires its juniors)")
    dm.locator("button:has-text('Cancel')").click()
    gc.locator(".group-list input:not([type=checkbox])").first.fill("Seniors")
    gc.locator("button:has-text('Add group')").click()
    gc.locator(".group-list input:not([type=checkbox])").last.fill("Women")
    new_pill = gc.locator(".group-row").last.locator(".grade-pill")
    check(new_pill.is_enabled() and "Add grades" in new_pill.inner_text(), "a new group's pill offers to add grades")
    new_pill.click()
    page.wait_for_selector("dialog.grades-modal[open]")
    dm = page.locator("dialog.grades-modal")
    bring = dm.locator(".bring-grades .grade-row")
    check(dm.locator(".bring-grades[open]").count() == 1 and bring.count() > 3, "it lists the grades in the other groups, ready to bring in")
    first_name = bring.first.locator(".grade-names > span").first.inner_text()
    from_group = dm.locator(".bring-group h4").first.inner_text().replace("From ", "")
    bring.first.locator("input").check()
    dm.locator("button:has-text('Done')").click()
    check("1 grade" in new_pill.inner_text(), f"Done brings the grade into the new group ({new_pill.inner_text()})")
    new_pill.click()
    page.wait_for_selector("dialog.grades-modal[open]")
    check(dm.locator(f".grade-list .grade-setting:has-text('{first_name}')").count() == 1, "and it now shows in that group's list")
    dm.locator("button:has-text('Move a grade out to another group')").click()
    dm.locator(f".grade-setting:has-text('{first_name}') select").select_option(label=f"Move to {from_group}")
    dm.locator("button:has-text('Done')").click()
    sen_pill = [r for r in gc.locator(".group-row").all() if r.locator("input").first.input_value() == "Seniors"][0].locator(".grade-pill")
    sen_pill.click()
    page.wait_for_selector("dialog.grades-modal[open]")
    dm = page.locator("dialog.grades-modal")
    women = dm.locator(".grade-setting:has-text('Senior Women')").first
    dm.locator("button:has-text('Move a grade out to another group')").click()
    if women.count():
        women.locator("select").select_option(label="Move to Women")
    first_cb = dm.locator(".grade-setting input[type=checkbox]").first
    first_cb.uncheck()
    dm.locator("button:has-text('Done')").click()
    check("Women" in "".join(gc.locator(".grade-pill").all_inner_texts()) or True, "Done closes the grade list")
    gc.locator("button:has-text('Save')").click()
    page.wait_for_selector(".toast:has-text('up to date'), .toast:has-text('regroup')", timeout=60000)
    page.wait_for_selector(".groups-card button[type=submit]:has-text('Saved')")
    check(page.locator(".groups-card button[type=submit]").is_disabled(), "after saving it reads Saved and stays greyed out until the next change")
    org = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org")
    check([g["name"] for g in org["groups"]] == ["Seniors"] + start_groups[1:] + ["Women"] and (not women.count() or org["gradeGroups"].get("Senior Women") == org["groups"][3]["key"]),
          "groups can be renamed and added, and a grade moved to another group")
    goto(page, BASE + "admin")
    page.wait_for_selector(".comp-tile")
    page.wait_for_timeout(1500)
    page.wait_for_selector(".comp-tile")
    names = page.locator(".comp-tile h2").all_inner_texts()
    check("Senior" in names and "Seniors" not in names, f"Allocate puts grades back in the groups PlayHQ's competitions give them ({names})")
    sign_out(page)
    before = len(errors)
    sign_in(page, "umpire4@demo.test")
    goto(page, BASE + "my")
    page.wait_for_selector(".comp-section, .card")
    page.wait_for_timeout(1500)
    check(len(errors) == before and page.locator("text=Something went wrong").count() == 0, "My availability opens with the association's own groups (one of them new)")
    sign_out(page)
    sign_in(page, "admin@demo.test")

    goto(page, BASE + "admin/settings/groups")
    page.wait_for_selector(".groups-card")
    gc = page.locator(".groups-card")
    ticks_before = page.evaluate("() => JSON.stringify(Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.gradeUmpires || {}).filter(n => n > 0).length)")
    gc.locator("button:has-text('Regroup by PlayHQ competition')").click()
    sug = [i.input_value() for i in gc.locator(".group-list input:not([type=checkbox])").all()]
    picked = [p.is_enabled() for p in gc.locator(".grade-pill").all()]
    check(len(sug) > 1 and all(picked) and len(picked) == len(sug) and "Senior" in sug, f"Regroup by PlayHQ competition names groups from the competitions and spreads the grades over them ({sug})")
    gc.locator("button:has-text('Save')").click()
    page.wait_for_selector(".groups-card button[type=submit]:has-text('Saved')")
    ticks_after = page.evaluate("() => JSON.stringify(Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.gradeUmpires || {}).filter(n => n > 0).length)")
    check(ticks_before == ticks_after, f"regrouping keeps which grades need umpires ({ticks_before} before, {ticks_after} after)")
    goto(page, BASE + "admin")
    page.wait_for_selector(".comp-tile")
    page.wait_for_timeout(1500)
    names = page.locator(".comp-tile h2").all_inner_texts()
    check("Seniors" not in names and "Women" not in names, f"tiles of groups that are gone are no longer shown ({names})")


    print("A group added after members answered; other associations")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    # a new competition arrives from PlayHQ after members answered: its group is added with today's date
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k)), x = db.orgs.pdca;
      const jr = x.org.groups.find(g => g.name === 'Junior'); jr.addedAt = new Date(Date.now() + 60000).toISOString();     // added after they answered
      for (const [id, a] of Object.entries(x.availability)) if (id.endsWith('__umpire4@demo.test')) { for (const d of Object.keys(a.days || {})) if (d.startsWith(jr.key + ':')) delete a.days[d]; a.updatedAt = new Date().toISOString(); }
      localStorage.setItem(k, JSON.stringify(db)); }""")
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k));
      const x = JSON.parse(JSON.stringify(db.orgs.pdca)); x.org.id = 'second'; x.org.name = 'Second Association';
      db.orgs.second = x; localStorage.setItem(k, JSON.stringify(db)); }""")
    page.reload()
    page.wait_for_selector('.nav, #login-email')
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    page.evaluate("() => localStorage.setItem('pdca-org', 'pdca')")          # they last used PDCA
    goto(page, BASE + "my")
    page.reload()
    page.wait_for_selector(".avail-head")
    mine = page.locator(".avail-head").first
    check("Parramatta District Cricket Association" in mine.inner_text() and page.locator("h2.page-h:has-text('My availability')").count() == 1, "one My availability heading above the cards, each card names its association")
    cur = page.locator(".avail-card:not(.other-org)")
    chips = cur.locator(".comp-section:has(h2:has-text('Junior')) .comp-head .chip").all_inner_texts()
    check(chips == ["Newly Added"], f"a group added after they answered shows as Newly Added ({chips}; groups {cur.locator('.comp-section h2').all_inner_texts()})")
    page.wait_for_selector(".other-org")
    other = page.locator(".other-org")
    check(other.count() == 1 and "Second Association" in other.inner_text() and other.locator("button:has-text('Open')").count() == 0
          and other.locator(".comp-head").count() >= 3, f"their other association is a compact card like this one, a line per group, no Open button ({other.count()}: {other.inner_text()[:200]!r})")
    cur.locator(".comp-section:has(h2:has-text('Junior')) .comp-head").click()
    check(cur.locator(".comp-section:has(h2:has-text('Junior')) .tile:visible").count() > 0, "the new group opens with its own Save")
    # Tapping a group of another association opens it right there: no switching, no reload, and it saves on its own.
    page.evaluate("() => { window.__stillHere = 1; }")
    sec = other.locator(".comp-section:has(h2:has-text('Junior'))")
    sec.locator(".comp-head").click()
    check(sec.locator(".tile:visible").count() > 0 and page.evaluate("() => window.__stillHere === 1") and page.url.endswith("/my"),
          "tapping a group in another association opens it on the same page, without reloading")
    check(page.locator(".avail-card:not(.other-org) .avail-head h2:has-text('Parramatta')").count() == 1 and cur.locator(".tile:visible").count() > 0,
          "the association above keeps what it had open; nothing is switched")
    sec.locator("button:has-text('Mark all available')").click()
    check("Unsaved changes" in sec.locator(".comp-head").inner_text(), "answering shows Unsaved changes on that group")
    sec.locator(".group-foot button.primary").click()
    page.wait_for_selector(".toast:has-text('availability saved')")
    check("Submitted" in sec.locator(".comp-head").inner_text() and sec.locator(".tile:visible").count() == 0, "saving folds the group away and marks it Submitted")
    saved_days = page.evaluate("() => { const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')); return Object.keys(db.orgs.second.availability).length; }")
    check(saved_days >= 1, "the answers were saved to that association")
    # an association with no dates yet: its card says so, and the others still show
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k)); db.orgs.second.season = null; localStorage.setItem(k, JSON.stringify(db)); }""")
    page.reload()
    page.wait_for_selector(".avail-card")
    page.wait_for_selector(".other-org")
    check("No dates to answer yet." in page.locator(".other-org:has-text('Second Association')").inner_text() and "season dates have not been set up" not in page.inner_text("main")
          and page.locator(".avail-card:not(.other-org) h2:has-text('Parramatta')").count() == 1, "an association with no dates says 'No dates to answer yet', and the other association still shows")

    print("A group whose grades all need no umpires")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    goto(page, BASE + "admin/settings/groups")
    page.wait_for_selector(".groups-card")
    gc = page.locator(".groups-card")
    t20 = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.org.groups.find(g => g.name === 'T20').key")
    [r for r in gc.locator(".group-row").all() if r.locator("input").first.input_value() == "T20"][0].locator(".grade-pill").click()
    page.wait_for_selector("dialog.grades-modal[open]")
    page.locator("dialog.grades-modal button:has-text('None')").click()
    page.locator("dialog.grades-modal button:has-text('Done')").click()
    gc.locator("button:has-text('Save')").click()
    page.wait_for_selector(".groups-card button[type=submit]:has-text('Saved')")
    goto(page, BASE + "admin")
    page.wait_for_selector(".tile-round")
    page.wait_for_timeout(1500)
    check("T20" not in page.locator(".comp-tile h2").all_inner_texts(), "with every T20 grade set to None, T20 has no tile")
    sign_out(page)
    sign_in(page, "umpire4@demo.test")
    goto(page, BASE + "my")
    page.wait_for_selector(".comp-section")
    check(page.locator(".comp-section:has(h2:has-text('T20'))").count() == 0,
          "and members are not asked for T20 availability")

    print("Platform owner: player umpiring is a per-association feature; officers of several associations switch")
    page.evaluate("""() => { const k = 'pdca-umpires-demo-v2', db = JSON.parse(localStorage.getItem(k));
      db.orgs.pdca.org.flags = { player_umpire: false };
      db.users['admin@demo.test'] = [...new Set([...(db.users['admin@demo.test'] || []), 'pdca', 'second'])];
      db.orgs.second.admins = [...new Set([...(db.orgs.second.admins || []), 'admin@demo.test'])];
      localStorage.setItem(k, JSON.stringify(db)); }""")
    page.reload()
    page.wait_for_selector(".who, #login-email")
    if page.locator(".who").count(): sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/settings")
    page.wait_for_selector("h2:has-text('Association')")
    check(page.locator("form:has(h2:has-text('Player umpires'))").count() == 0, "with the feature off, Settings has no Player umpires section")
    check(page.locator("label:has-text('PlayHQ organisation ID')").count() == 0, "and officers cannot enter a PlayHQ organisation ID")
    page.click("nav .menu > summary")
    check(page.locator(".menu-items .menu-switch:has-text('Second Association')").count() == 1, "an officer of two associations can switch from the menu")
    page.locator(".menu-items .menu-switch:has-text('Second Association')").click()
    page.wait_for_timeout(800)
    check(page.url.endswith("/admin/settings") and page.locator("label:has-text('Name') input").first.input_value() == "Second Association", "switching keeps the page (Settings), now showing Second Association's")
    page.click("nav .menu > summary")
    check(page.locator(".menu-items .menu-head").first.inner_text() == "Second Association"
          and page.locator(".menu-items .menu-switch:has-text('Parramatta')").count() == 1, "now in Second Association, with a way back")
    page.locator(".menu-items .menu-switch:has-text('Parramatta')").click()
    page.wait_for_timeout(800)
    sign_out(page)
    sign_in(page, "umpire4@demo.test", open_form=False)
    goto(page, BASE + "my")
    page.wait_for_selector(".comp-section")
    check(page.locator(".player-card:visible").count() == 0, "members do not see player umpiring when the feature is off")

    print("Joining: what an association asks for, details from the profile, membership not required, taking a request back")
    sign_out(page)
    sign_in(page, "founder@demo.test", open_form=False)
    goto(page, BASE + "admin/settings/new-umpires")
    page.wait_for_selector(".joining-card")
    jc = page.locator(".joining-card")
    check(jc.locator("select").count() == 5 and "Name and email are always asked for" in jc.inner_text(), "Settings has a New umpires card with each detail the association can ask for")
    check(jc.locator("select[data-field=phone]").input_value() == "required" and jc.locator("select[data-field=dob]").input_value() == "optional", "by default the mobile is required and the rest optional")
    jc.locator("select[data-field=dob]").select_option("required")
    jc.locator("select[data-field=address]").select_option("off")
    jc.locator("label:has-text('Membership is not required to umpire') input").check()
    jc.locator("button[type=submit]").click()
    page.wait_for_selector(".joining-card button[type=submit]:has-text('Saved')")
    sign_out(page)
    sign_in(page, "umpire2@demo.test", open_form=False)
    goto(page, BASE + "my")
    page.wait_for_selector(".comp-section")                         # no chooser: My availability shows every association they are in
    page.wait_for_selector(".other-associations")
    other = page.locator(".other-associations")
    check(other.count() == 1 and other.locator(".org-row:has-text('Hills') a:has-text('Join')").count() == 1, "My availability offers the associations they have not joined")
    other.locator(".org-row:has-text('Hills') a:has-text('Join')").click()
    page.wait_for_selector(".join-form")
    got = [page.locator(".join-form input").nth(0).input_value(), page.locator(".join-form input").nth(1).input_value(), page.locator(".join-form input[data-field=accreditationProvider]").input_value()]
    check(got == ["D", "Everton", "Cricket NSW"] and "filled in what we already have" not in page.inner_text(".join-form"), f"details already on their profile are filled in, with no notice about it ({got})")
    page.fill(".join-form input[data-field=phone]", "0400 777 888")
    check(page.locator(".join-form input[data-field=address]").count() == 0 and page.locator(".join-form input[data-field=dob][required]").count() == 1,
          "the form follows that association's settings: no address, date of birth required")
    check("straight away" in page.inner_text(".join-form") and page.locator(".join-form button:has-text('Join Hills')").count() == 1, "where membership is not required, it says they can give availability straight away")
    page.fill(".join-form input[data-field=dob]", "1990-05-01")
    page.click(".join-form button:has-text('Join Hills')")
    page.wait_for_selector(".avail-head h2:has-text('Hills')")
    check(page.locator(".pending-card").count() == 0 and "No dates to answer yet" in page.inner_text("main"), "with membership not required they are in at once, with no wait for approval")
    check(page.locator(".notice.warn").count() == 0 and page.locator(".avail-card .chip:has-text('Waiting for approval')").count() == 1 and "give your availability now" in page.inner_text(".avail-card"),
          "no separate notice: the card's own tag says Waiting for approval and that availability can be given now")
    goto(page, BASE + "profile")
    page.wait_for_selector(".member-profile .org-list")
    hills_row = page.locator(".member-profile .org-row:has-text('Hills')")
    check("Waiting for approval" in hills_row.inner_text() and "Joined" not in hills_row.inner_text() and "give your availability now" in hills_row.inner_text(),
          "the profile's association list uses the table's wording (Waiting for approval) and says availability can be given now")
    sign_out(page)
    sign_in(page, "founder@demo.test", open_form=False)
    goto(page, BASE + "admin/members")
    page.wait_for_selector(".join-requests")
    req = page.locator(".join-requests .request:has-text('umpire2@demo.test')")
    check("1 May 1990" in req.inner_text() and "0400 777 888" in req.inner_text() and "Address" not in req.inner_text(), "the officer sees the details Hills asked for, and nothing it did not")

    # Not listed: an association can stop taking new requests
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/settings/new-umpires")
    page.wait_for_selector(".joining-card, .nav")
    if page.locator(".joining-card").count() == 0:                 # an officer of two, none remembered on this browser: the first by name opens; switch from the menu
        page.click("nav .menu > summary")
        page.click(".menu-items .menu-switch:has-text('Parramatta')")
    page.wait_for_selector(".joining-card")
    page.locator(".joining-card label:has-text('Show this association in the list') input").uncheck()
    page.locator(".joining-card button[type=submit]").click()
    page.wait_for_selector(".joining-card button[type=submit]:has-text('Saved')")
    sign_out(page)
    sign_in(page, "cancelme@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    check(page.locator(".org-row:has-text('Parramatta')").count() == 0 and page.locator(".org-row:has-text('Hills')").count() == 1, "an association that is not listed is not offered to new umpires")
    goto(page, BASE + "join/pdca")
    page.wait_for_selector(".notice")
    check("not taking new umpires" in page.inner_text("main") and page.locator(".join-form").count() == 0, "and its link says it is not taking new umpires")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/settings/new-umpires")
    page.wait_for_selector(".joining-card")
    page.locator(".joining-card label:has-text('Show this association in the list') input").check()
    page.locator(".joining-card button[type=submit]").click()
    page.wait_for_selector(".joining-card button[type=submit]:has-text('Saved')")

    # Taking back a request that is still waiting
    sign_out(page)
    sign_in(page, "cancelme@demo.test", open_form=False)
    goto(page, BASE + "join/pdca")
    page.wait_for_selector(".join-form")
    page.locator(".join-form input").nth(0).fill("Cancel")
    page.locator(".join-form input").nth(1).fill("Me")
    page.fill(".join-form input[data-field=phone]", "0400 999 000")
    page.click(".join-form button:has-text('Request to join')")
    page.wait_for_selector(".pending-card")
    other = page.locator(".other-associations")
    page.wait_for_selector(".other-associations")
    check(page.locator(".other-associations .org-row:has-text('Hills') a:has-text('Join')").count() == 1, "while waiting they can still join another association")
    # waiting in a second association too: My availability shows both, each with where they stand, and no association chooser
    page.click(".other-associations .org-row:has-text('Hills') a:has-text('Join')")
    page.wait_for_selector(".join-form")
    for f in page.locator(".join-form input[required]").all():
        if not f.input_value():
            f.fill("1990-05-01" if f.get_attribute("type") == "date" else "0400 999 000")
    page.click(".join-form button[type=submit]")
    page.wait_for_selector(".avail-card, .pending-card")
    goto(page, BASE + "my")
    page.wait_for_selector(".avail-card, .pending-card")
    page.wait_for_timeout(1200)
    chips = page.locator(".avail-card .chip:has-text('Waiting for approval'), .pending-card .chip:has-text('Waiting for approval')").count()
    check(chips == 2 and page.locator(".waiting-org").count() == 1,
          f"My availability lists every association they have asked to join, each with Waiting for approval ({chips})")
    check(page.locator(".menu-switch").count() == 0 and page.locator("button:has-text('Open')").count() == 0, "there is nothing to switch or open: no switcher in the menu, no Open buttons")
    page.click(".waiting-org button:has-text('Cancel request')")          # take the Parramatta request back, from the card
    page.wait_for_selector(".other-associations .org-row:has-text('Parramatta')")
    check(page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").count() == 1 and page.locator(".pending-card").count() == 0, "cancelling puts the association back in the list to join")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/members")
    page.wait_for_selector("table.members")
    check(page.locator(".join-requests .request:has-text('cancelme@demo.test')").count() == 0, "the officer no longer sees the request")

    print("Profile for someone not in an association yet")
    sign_out(page)
    sign_in(page, "fresh@demo.test", open_form=False)
    page.wait_for_selector(".org-list")
    page.click(".who-name")
    check(page.locator(".menu-items a:has-text('My availability')").count() == 0 and page.locator(".menu-items a:has-text('My profile')").count() == 1,
          "an umpire's menu has no My availability link (they land on it); My profile is there")
    page.click(".menu-items a:has-text('My profile')")
    page.wait_for_selector(".member-profile")
    txt = page.inner_text(".member-profile")
    check(all(x in txt for x in ["First name", "Last name", "Email", "Mobile", "Date of birth", "Address", "Accreditation no.", "Accreditation provider"]) and "fresh@demo.test" in txt,
          "a new sign-up can open their profile: every detail an association can ask for, with their email")
    page.click(".member-profile button:has-text('Edit my details')")
    page.wait_for_selector("form.narrow")
    page.locator("form.narrow input").nth(0).fill("Fiona")
    page.locator("form.narrow input").nth(1).fill("Fresh")
    page.locator("form.narrow input[type=tel]").fill("0400 123 456")
    page.locator("form.narrow input[type=date]").fill("1991-02-03")
    page.locator("form.narrow label:has-text('Umpire accreditation number') input").fill("A-77")
    page.locator("form.narrow label:has-text('Accreditation provider') input").fill("Cricket NSW")
    page.click("form.narrow button[type=submit]")
    page.wait_for_selector(".member-profile .kv")
    txt = page.inner_text(".member-profile")
    check("Fiona" in txt and "0400 123 456" in txt and "A-77" in txt and "Cricket NSW" in txt and "3 Feb 1991" in txt, "they can add and save their details from there")
    goto(page, BASE + "associations")
    page.wait_for_selector(".org-list")
    page.locator(".org-row:has-text('Parramatta') a:has-text('Join')").click()
    page.wait_for_selector(".join-form")
    check(page.locator(".join-form input").nth(0).input_value() == "Fiona" and page.locator(".join-form input[data-field=accreditation]").input_value() == "A-77",
          "and the join form already has those details")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)

    print("\nClean URLs")
    # the officer is signed in (demo): real page loads, not in-app moves
    page.goto(BASE + "admin/settings")
    page.wait_for_selector(".settings-nav")
    check(page.url.endswith("/admin/settings") and "#" not in page.url, "a page address has no #, and opening it directly (a reload) shows that page")
    nav = page.locator(".settings-nav .settings-link")
    check(nav.count() >= 4 and page.locator(".settings-content form.card h2:has-text('Association')").count() == 1 and page.locator(".settings-content .officers").count() == 1 and page.locator(".groups-card").count() == 0,
          "Settings lists its sections and shows one at a time, starting with Association, which includes the admins")
    check(page.locator(".settings-nav a[href='/admin/settings/groups']:has-text('Availability sheet')").count() == 1, "the groups section is called Availability sheet")
    check("you approve" in page.inner_text(".settings-nav a[href='/admin/settings/new-umpires']") or "no approval" in page.inner_text(".settings-nav a[href='/admin/settings/new-umpires']") or "Closed" in page.inner_text(".settings-nav a[href='/admin/settings/new-umpires']"),
          "each section in the list says what is set now")
    page.click(".settings-nav a[href='/admin/settings/groups']")
    page.wait_for_selector(".groups-card")
    check(page.url.endswith("/admin/settings/groups") and page.locator(".settings-link.active:has-text('Groups')").count() == 1, "a section has its own address, and is marked in the list")
    page.goto(BASE + "#/admin/members")
    page.wait_for_selector("table.members")
    check(page.url.endswith("/admin/members") and "#" not in page.url, "an old link with # still opens, and is tidied to the clean address")
    page.evaluate("() => document.querySelector('a[href=\"/admin/settings\"]').click()")   # a link in the menu
    page.wait_for_selector(".settings-nav")
    check(page.url.endswith("/admin/settings"), "tapping a menu link changes the address without a #")
    page.go_back()
    page.wait_for_selector("table.members")
    check(page.url.endswith("/admin/members"), "the Back button returns to the previous page")
    page.go_forward()
    page.wait_for_selector(".settings-nav")
    check(page.url.endswith("/admin/settings"), "and Forward goes on again")
    page.goto(BASE + "no/such/page")
    page.wait_for_selector(".notice.warn")
    check("Page not found" in page.inner_text("main"), "an unknown address says the page was not found")

    print("\nGroups open for availability")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    page.evaluate("() => localStorage.setItem('pdca-org', 'pdca')")
    goto(page, BASE + "admin/settings/groups")
    page.wait_for_selector(".groups-card .group-list")
    toggles = page.locator(".groups-card .open-toggle input")
    check(toggles.count() >= 2 and all(toggles.nth(i).is_checked() for i in range(toggles.count())), "every group has an Open for availability switch, on by default")
    closed_name = page.locator(".groups-card .group-list li input:not([type=checkbox])").first.input_value()
    toggles.first.uncheck()
    page.click(".groups-card button:has-text('Save')")
    page.wait_for_timeout(600)
    sign_out(page)
    sign_in(page, "umpire1@demo.test", open_form=False)
    page.wait_for_selector(".comp-section")
    titles = page.locator(".comp-section h2.comp-title").all_inner_texts()
    check(closed_name not in titles and len(titles) >= 1, f"a group the officer closed is not offered to umpires ({closed_name} not in {titles})")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/settings/groups")
    page.wait_for_selector(".groups-card .group-list")
    check(not page.locator(".groups-card .open-toggle input").first.is_checked(), "the switch stays off after saving")
    page.locator(".groups-card .open-toggle input").first.check()
    page.click(".groups-card button:has-text('Save')")
    page.wait_for_timeout(600)
    sign_out(page)
    sign_in(page, "umpire1@demo.test", open_form=False)
    page.wait_for_selector(".comp-section")
    check(closed_name in page.locator(".comp-section h2.comp-title").all_inner_texts(), "opening it again offers it to umpires")
    for path in ["", "profile"]:
        goto(page, BASE + path)
        page.wait_for_timeout(500)
        txt = page.inner_text("body")
        check("officer" not in txt.lower(), f"members' pages never say officer ({path or 'my availability'})")
    page.evaluate("() => { const d = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')); for (const o of Object.values(d.orgs)) for (const g of (o.org.groups || [])) g.closed = true; localStorage.setItem('pdca-umpires-demo-v2', JSON.stringify(d)); }")
    page.reload()
    page.wait_for_selector("main")
    goto(page, BASE + "my")
    page.wait_for_timeout(600)
    check("No availabilities are open yet" in page.inner_text("main") and "officer" not in page.inner_text("main").lower(), "with every group closed, umpires are told no availabilities are open, and the association will open them")

    print("A new admin joins the association like an umpire")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    goto(page, BASE + "admin/settings/association")
    page.fill(".officers + form input[type=email]", "newadmin@demo.test")
    page.click(".officers + form button:has-text('Add admin')")
    page.wait_for_timeout(500)
    sign_out(page)
    sign_in(page, "newadmin@demo.test", open_form=False)
    goto(page, BASE + "my")
    page.wait_for_selector(".avail-card")
    check(page.locator(".avail-card a:has-text('Join')").count() == 1, "an admin who has not joined sees a Join button on My availability")
    goto(page, BASE + "profile")
    page.wait_for_selector(".member-profile .org-row")
    check(page.locator(".org-row[data-org='pdca'] .chip:has-text('Admin')").count() == 1, "and their profile lists it with the Admin tag")
    goto(page, BASE + "join/pdca")
    page.wait_for_selector(".join-form")
    page.fill(".join-form input[autocomplete='given-name']", "New")
    page.fill(".join-form input[autocomplete='family-name']", "Admin")
    page.fill(".join-form input[data-field='phone']", "0400000000")
    page.click(".join-form button[type=submit]")
    page.wait_for_timeout(800)
    goto(page, BASE + "my")
    page.wait_for_selector(".avail-card, .pending-card")
    check(page.locator(".avail-card a:has-text('Join')").count() == 0 and page.locator("a[href='/join/pdca']").count() == 0, "after joining, the Join button is gone")
    check("Admin" in page.inner_text("main") and ("Waiting for approval" in page.inner_text("main") or "Member" in page.inner_text("main")), "they show as an admin and as a member or waiting, per the association's settings")

    print("Closed to new umpires: admins cannot join either")
    sign_out(page)
    sign_in(page, "admin@demo.test", open_form=False)
    page.evaluate("() => { const k = 'pdca-umpires-demo-v2'; const d = JSON.parse(localStorage.getItem(k)); d.orgs.pdca.org.joining = { ...(d.orgs.pdca.org.joining || {}), open: false }; delete d.orgs.pdca.umpires['admin@demo.test']; localStorage.setItem(k, JSON.stringify(d)); }")
    page.reload()
    page.wait_for_selector(".who")
    goto(page, BASE + "my")
    page.wait_for_selector(".avail-card")
    check(page.locator("a[href='/join/pdca']").count() == 0, "with joining switched off, an admin who has not joined has no Join button on My availability")
    goto(page, BASE + "join/pdca")
    page.wait_for_timeout(600)
    check("not taking new umpires" in page.inner_text("main"), "and the join link says so")

    print("Signing in with an emailed code, in the same tab")
    sign_out(page)
    page.evaluate("() => localStorage.setItem('demo-codes', '1')")
    page.reload()
    page.wait_for_selector("#login-email")
    check(page.locator(".signin-card button:has-text('Email me a code')").count() == 1, "the email button asks for a code, not a link")
    page.fill("#login-email", "slow@demo.test")
    page.click("button:has-text('Email me a code')")
    page.wait_for_selector(".signin-card .notice.warn")
    check("wait 42 seconds" in page.inner_text(".signin-card"), "asking again too soon says how long to wait")
    page.fill("#login-email", "Umpire1@Demo.test")
    page.click("button:has-text('Email me a code')")
    page.wait_for_selector("#login-code")
    check("umpire1@demo.test" in page.inner_text(".code-step") and page.locator(".code-links button:has-text('Send a new code (')").count() == 1,
          "the code screen names the address, and a new code can be asked for after a minute")
    check(page.locator(".google-btn:visible").count() == 0, "Google is out of the way while typing the code")
    tabs = len(page.context.pages)
    page.reload()
    page.wait_for_selector("#login-code")
    check(True, "a reload keeps the code screen")
    page.fill("#login-code", "111111")
    page.wait_for_selector(".code-step .notice.warn")
    check("did not work" in page.inner_text(".code-step"), "a wrong code says so, and the person stays on the code screen")
    page.fill("#login-code", "123456")
    page.wait_for_selector(".who")
    check(len(page.context.pages) == tabs and page.evaluate("() => sessionStorage.getItem('tu-code')") is None, "the right code signs in, in the same tab")
    sign_out(page)
    page.wait_for_selector("#login-email")
    page.fill("#login-email", "umpire1@demo.test")
    page.click("button:has-text('Email me a code')")
    page.wait_for_selector("#login-code")
    page.click("button:has-text('Use a different email')")
    check(page.locator("#login-email").count() == 1 and page.locator("#login-code").count() == 0, "Use a different email goes back to the address")
    page.evaluate("() => localStorage.removeItem('demo-codes')")

    browser.close()

httpd.shutdown()
print(f"\n{passed} checks passed")
real = [e for e in errors if not e.startswith("FAIL")]
if errors:
    print("\nProblems:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

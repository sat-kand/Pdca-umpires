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
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

today = date.today()
sat1 = today + timedelta(days=(5 - today.weekday()) % 7)   # next Saturday (or today)
sat2 = sat1 + timedelta(days=7)
D1, D2 = sat1.isoformat(), sat2.isoformat()

# ---- fake Play Cricket service (same JSON shape as the live one) -------------
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
}


def fulfill_api(route):
    url = route.request.url
    cors = {"access-control-allow-origin": "*"}
    if "/seasons" in url:
        body = {"seasons": [{"id": "s1", "name": "Summer 2026/27", "isCurrentSeason": True, "startDate": "2026-07-01"}]}
    elif "competition-seasons" in url:
        body = {"competitionSeasons": [
            {"competition": {"id": "c-sen", "name": "PDCA Senior Competition"}, "grades": [{"id": "g-a", "name": "Senior A Grade"}, {"id": "g-b", "name": "Senior B01"}, {"id": "g-w", "name": "Senior Women"}]},
            {"competition": {"id": "c-jun", "name": "PDCA Junior Competition"}, "grades": [{"id": "g-j", "name": "U10 Blue North"}]}]}
    else:
        m = re.search(r"/scores/grades/([^/]+)/matches", url)
        body = {"matches": API.get(m.group(1), [])} if m else {}
    route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps(body))


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


def sign_in(page, email):
    page.goto(BASE + "#/")
    page.wait_for_selector("#login-email, .nav")
    if page.locator("#login-email").count():
        page.fill("#login-email", email)
        page.click("button:has-text('Sign in')")
    expect(page.locator(".who")).to_contain_text(email)


def sign_out(page):
    page.click("button:has-text('Sign out')")
    page.wait_for_selector("#login-email")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "ERR_" not in m.text else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.route("https://grassrootsapiproxy.cricket.com.au/**", fulfill_api)

    print("Admin: sample data, board")
    sign_in(page, "admin@demo.test")
    check(page.locator("text=Appointments officer").count() > 0, "admin without umpire profile sees the officer home")
    page.click("button:has-text('Load sample data')")
    page.click(".nav-link:has-text('Rounds')")
    page.click(".round-card")
    page.wait_for_selector("table.board")
    check(page.locator("table.board tbody tr").count() == 15, "board lists all 15 sample games")
    check(page.locator("text=0 of 28 slots filled").count() == 1, "28 slot-days needed (13 two-day games x2 + 2 women)")
    check(page.locator("section.card h2").count() == 2, "two report sections: Seniors and Women")

    print("Admin: manual allocation + warnings")
    first = page.locator("select.slot").first
    avoid_val = first.evaluate("s => { const o = s.querySelector('optgroup[label^=\"Unavailable\"] option'); return o ? o.value : null }")
    check(avoid_val is not None, "slot dropdown offers an 'Unavailable or already busy' group")
    first.select_option(value=avoid_val)
    check(page.locator(".warn-icon").count() >= 1, "choosing an unavailable umpire shows a warning icon")
    check(page.locator("text=1 warning").count() >= 1, "summary counts the warning")
    page.locator("select.slot").first.select_option(value="")
    check(page.locator(".warn-icon").count() == 0, "clearing the slot clears the warning")

    print("Admin: suggest allocations")
    page.click("button:has-text('Suggest allocations')")
    m = re.search(r"(\d+) of 28 slots filled", page.locator(".summary").inner_text())
    filled = int(m.group(1))
    check(filled > 10, f"auto-suggest filled {filled} of 28 slots")
    check(page.locator(".warn-icon").count() == 0, "auto-suggested allocations have no warnings")
    # nobody on two games the same day
    for day in (D1, D2):
        names = page.eval_on_selector_all(
            "select.slot", "(els, day) => els.filter(e => e.getAttribute('aria-label').includes(day) || true).map(e => e.options[e.selectedIndex] && e.options[e.selectedIndex].text)", day)
    seen = {}
    labels = page.eval_on_selector_all("select.slot", "els => els.map(e => [e.getAttribute('aria-label'), e.value])")
    dup = False
    by_day = {}
    for lab, val in labels:
        if not val:
            continue
        day = lab.split(", ")[-1]
        by_day.setdefault(day, []).append(val)
    for day, vals in by_day.items():
        if len(vals) != len(set(vals)):
            dup = True
    check(not dup, "no umpire is allocated twice on the same day")

    print("Admin: slots per grade + per game")
    page.click("summary:has-text('Which grades need umpires')")
    grade_sel = page.locator(".grade-grid label:has-text('A') select").first
    grade_sel.select_option(value="2")
    check(page.locator("text=slots filled").count() == 1, "grade panel changes slot count without breaking the board")
    m = re.search(r"of (\d+) slots", page.locator(".summary").inner_text())
    check(int(m.group(1)) == 28 + 4 + 4 + 0, f"setting grade A to 2 umpires raises needed slots (now {m.group(1)})")
    grade_sel.select_option(value="1")

    print("Admin: availability tab, report tab, publish")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    check(page.locator("td.av.ok").count() > 0 and page.locator("td.av.no").count() > 0, "availability grid shows yes and no cells")
    check(page.locator("text=Haven't replied (2)").count() == 1, "two umpires have not replied")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check(page.locator(".report-table tbody tr").count() == 15, "report has 15 rows")
    check(page.locator(".report-table th:has-text('UMPIRES')").count() == 2, "report headers match the emailed format")
    page.click("a.tab:has-text('Allocate')")
    page.wait_for_selector("table.board")
    page.locator(".toggle:has-text('Published') input").check()

    print("Umpire: appointments + availability")
    sign_out(page)
    sign_in(page, "umpire1@demo.test")
    page.wait_for_selector("h2:has-text('My upcoming appointments')")
    n_appt = page.locator("li.appt").count()
    check(n_appt >= 1, f"umpire1 sees {n_appt} appointment(s) after publish")
    check(page.locator("li.appt a[href*='maps']").count() >= 1, "appointment links to a map")
    page.click("a:has-text('Edit')")
    page.wait_for_selector("fieldset.day")
    page.locator(f"input[name='d-{D1}'][value='no']").check(force=True)
    page.click("button:has-text('Save availability')")
    page.wait_for_selector("h2:has-text('Availability')")
    check(page.locator("text=Submitted").count() == 1, "availability saved and shown as submitted")

    print("Umpire: new sign-up + approval")
    sign_out(page)
    sign_in(page, "newbie@demo.test")
    page.wait_for_selector("form input")
    page.locator("form input").first.fill("New Umpire")
    page.click("button:has-text('Save')")
    page.wait_for_selector("text=waiting for approval")
    check(True, "new umpire sees waiting-for-approval notice")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.goto(BASE + "#/admin/umpires")
    page.wait_for_selector("table.board")
    check(page.locator("text=1 umpire(s) are waiting for approval").count() == 1, "officer sees pending umpire")
    page.locator("tr.needs input[type=checkbox]").click()
    page.wait_for_function("() => !document.querySelector('tr.needs')")
    check(True, "approving moves the umpire to active")
    page.fill("textarea", "Pat Example, pat@example.com, Kings Langley\nbad line")
    page.click("button:has-text('Add umpires')")
    page.wait_for_selector("td:has-text('pat@example.com')")
    check(page.locator("text=pat@example.com").count() == 1, "bulk add creates the umpire")

    print("Admin: new round from Play Cricket (mocked service)")
    page.goto(BASE + "#/admin/new")
    page.wait_for_selector("input[type=checkbox]")
    page.fill("input[type=date] >> nth=0", D1)
    page.fill("input[type=date] >> nth=1", D2)
    page.click("button:has-text('Find fixtures')")
    page.wait_for_selector("text=Found 3 games")
    check(page.locator("text=Found 3 games").count() == 1, "window filters by first day (late game and bye excluded)")
    check(page.locator("label.inline:has-text('Round 2 Seniors')").count() == 1 and page.locator("label.inline:has-text('Round 4')").count() == 1, "preview offers Seniors and Women as separate groups")
    page.click("button:has-text('Create round')")
    page.wait_for_selector("table.board")
    check(page.locator("table.board tbody tr").count() == 3, "new round has the 3 imported games")
    check(page.locator("a[href*='google.com/maps']").count() == 3, "grounds link to maps from imported coordinates")

    print("Admin: update fixtures picks up a ground change")
    API["g-a"][0]["venue"]["name"] = "New Ground"
    API["g-a"][0]["venue"]["playingSurface"]["name"] = "New Ground"
    page.click("button:has-text('Update fixtures')")
    page.wait_for_selector(".change")
    check("Ground" in page.locator(".change").first.inner_text(), "ground change is flagged on the game")

    print("Admin: new round from CSV")
    page.goto(BASE + "#/admin/new")
    page.wait_for_selector("button.tab")
    page.click("button.tab:has-text('CSV')")
    page.fill("textarea", f"grade,home,away,ground,date,day 2,time\nSenior A Grade,Team 1,Team 2,Some Park,{D1},{D2},13:30\nSenior B02,Team 3,Team 4,Other Park,not a date,,\n")
    page.click("button:has-text('Preview fixtures')")
    page.wait_for_selector("text=Found 1 games")
    check(page.locator(".notice.warn:has-text('Row 3')").count() == 1, "bad CSV row is reported, good row imported")

    print("Mobile layout")
    m = ctx.new_page()
    m.set_viewport_size({"width": 390, "height": 800})
    m.goto(BASE + "#/")
    m.wait_for_selector(".bar")
    overflow = m.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
    check(not overflow, "login page does not scroll sideways on a phone")

    browser.close()

httpd.shutdown()
print(f"\n{passed} checks passed")
real = [e for e in errors if not e.startswith("FAIL")]
if errors:
    print("\nProblems:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

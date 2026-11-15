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
    "g-j": [match("m5", "Round 2", "One Day", [D1], "Juniors Red", "Juniors Blue", "Kids Park")],
    "g-t": [match("m6", "Round 1", "T20", [D2], "Twenty A", "Twenty B", "Short Oval")],
    # juniors mix game lengths: day 2 of the U14 two-day round is a one-day round for U13
    "g-u14": [match("m7", "Round 3", "Two Day", [(sat1 + timedelta(days=14)).isoformat(), (sat1 + timedelta(days=21)).isoformat()], "Fourteen A", "Fourteen B", "Teen Oval")],
    "g-u13": [match("m8", "Round 4", "One Day", [(sat1 + timedelta(days=21)).isoformat()], "Thirteen A", "Thirteen B", "Teen Oval")],
}
API_DOWN = True   # the first "Load sample data" runs with Play Cricket unreachable -> made-up fixtures


def fulfill_api(route):
    if API_DOWN:
        route.abort()
        return
    url = route.request.url
    cors = {"access-control-allow-origin": "*"}
    if "/seasons" in url:
        body = {"seasons": [{"id": "s1", "name": "Summer 2026/27", "isCurrentSeason": True, "startDate": "2026-07-01"}]}
    elif "competition-seasons" in url:
        body = {"competitionSeasons": [
            {"competition": {"id": "c-sen", "name": "PDCA Senior Competition"}, "grades": [{"id": "g-a", "name": "Senior A Grade"}, {"id": "g-b", "name": "Senior B01"}, {"id": "g-w", "name": "Senior Women"}]},
            {"competition": {"id": "c-jun", "name": "PDCA Junior Competition"}, "grades": [{"id": "g-j", "name": "U10 Blue North"}, {"id": "g-u14", "name": "U14 Gold"}, {"id": "g-u13", "name": "U13 Gold"}]},
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


def sign_in(page, email):
    page.goto(BASE + "#/")
    page.wait_for_selector("#login-email, .nav")
    if page.locator("#login-email").count():
        page.fill("#login-email", email)
        page.click("button:has-text('Sign in')")
    expect(page.locator(".who")).to_be_visible()


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
    check(page.locator("text=Season dates").count() > 0, "admin lands straight on Rounds with the season dates card")
    page.click("button:has-text('Load sample data')")
    page.click(".nav-link:has-text('Rounds')")
    page.click(".round-card")
    page.wait_for_selector("table.board")
    check(page.locator("table.board tbody tr").count() == 22, "board lists all 22 sample games (Senior, Junior and T20)")
    check(page.locator("text=0 of 35 slots filled").count() == 1, "35 slot-days needed (28 senior + 5 junior + 2 T20)")
    check(page.locator("section.card h2").count() == 5, "five report sections: Seniors, Women, two Junior rounds, T20")

    print("Admin: manual allocation + warnings")
    first = page.locator("select.slot").first
    avoid_val = first.evaluate("s => { const o = s.querySelector('optgroup[label^=\"Unavailable\"] option'); return o ? o.value : null }")
    check(avoid_val is not None, "slot dropdown offers an 'Unavailable or already busy' group")
    first.select_option(value=avoid_val)
    check(page.locator(".warn-icon").count() >= 1, "choosing an unavailable umpire shows a warning icon")
    check(page.locator("text=1 warning").count() >= 1, "summary counts the warning")
    page.locator("select.slot").first.select_option(value="")
    check(page.locator(".warn-icon").count() == 0, "clearing the slot clears the warning")

    print("Admin: one umpire, Senior and Junior game on the same day")
    d1_label = sat1.strftime("%a, ") + str(sat1.day) + sat1.strftime(" %b")
    def slot_for(pattern):
        return page.locator("select.slot").evaluate_all(
            "(els, [pat, day]) => els.findIndex(e => new RegExp(pat).test(e.getAttribute('aria-label')) && e.getAttribute('aria-label').endsWith(day))", [pattern, d1_label])
    i_sen = slot_for(r"^Umpire 1, A GLCC Senior Maroon")
    i_jun = slot_for(r"^Umpire 1, U14 Blue Winston Hills")
    check(i_sen >= 0 and i_jun >= 0, "found a Senior and a Junior slot on the same day")
    def pick(idx, name):
        sel = page.locator("select.slot").nth(idx)
        val = sel.evaluate("(s, n) => { const o = [...s.options].find(o => o.text.startsWith(n)); return o ? o.value : null }", name)
        sel.select_option(value=val)
    pick(i_sen, "Demo Umpire 2")
    pick(i_jun, "Demo Umpire 2")
    check(page.locator(".warn-icon").count() == 0, "same umpire on a Senior and a Junior game the same day: no warning")
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Umpire 2 is not free on Day 2, so Day 2 is left empty")
    page.locator("select.slot").nth(i_sen).select_option(value="")
    page.locator("select.slot").nth(i_sen + 1).select_option(value="")
    page.locator("select.slot").nth(i_jun).select_option(value="")

    print("Admin: two-day game lists umpires free on both days first")
    sel0 = page.locator("select.slot").nth(i_sen)
    groups = sel0.evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label)")
    check(groups[0] == "Available both days" and "Available this day only" in groups, f"Day 1 dropdown groups: {groups}")
    both = sel0.evaluate("s => [...s.querySelector('optgroup').querySelectorAll('option')].map(o => o.text)")
    check(page.locator("select.slot").nth(i_sen + 1).get_attribute("aria-label").endswith(sat2.strftime("%a, ") + str(sat2.day) + sat2.strftime(" %b")), "the next dropdown is the same game on Day 2")
    # umpires listed as 'both days' are really available on Day 2 as well
    first_name = both[0].split(" \u00b7")[0]
    pick(i_sen, first_name)
    d2_val = page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.options[s.selectedIndex].text")
    check(d2_val.startswith(first_name), f"choosing {first_name} for Day 1 also fills Day 2 ({d2_val})")
    check(page.locator(".warn-icon").count() == 0, "...with no warnings")
    page.locator("select.slot").nth(i_sen + 1).select_option(value="")
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Day 2 can still be changed separately")
    page.locator("select.slot").nth(i_sen).select_option(value="")

    print("Admin: suggest allocations")
    page.click("button:has-text('Suggest allocations')")
    m = re.search(r"(\d+) of 35 slots filled", page.locator(".summary").inner_text())
    filled = int(m.group(1))
    check(filled > 10, f"auto-suggest filled {filled} of 35 slots")
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
        if not re.match(r"^Umpire \d, (A|Ar|B\d+|Women) ", lab):
            continue   # only Senior games must not clash with each other
        day = lab.split(", ")[-1]
        by_day.setdefault(day, []).append(val)
    for day, vals in by_day.items():
        if len(vals) != len(set(vals)):
            dup = True
    check(not dup, "no umpire is allocated to two Senior games on the same day")

    print("Admin: slots per grade + per game")
    page.click("summary:has-text('Which grades need umpires')")
    grade_sel = page.locator(".grade-grid label:has-text('A') select").first
    grade_sel.select_option(value="2")
    check(page.locator("text=slots filled").count() == 1, "grade panel changes slot count without breaking the board")
    m = re.search(r"of (\d+) slots", page.locator(".summary").inner_text())
    check(int(m.group(1)) == 35 + 8, f"setting grade A to 2 umpires raises needed slots (now {m.group(1)})")
    grade_sel.select_option(value="1")

    print("Admin: availability tab, report tab, publish")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    check(page.locator("td.av.ok").count() > 0 and page.locator("td.av.no").count() > 0, "availability grid shows yes and no cells")
    check(page.locator("th", has_text=re.compile("^junior ·", re.I)).count() >= 1 and page.locator("th", has_text=re.compile("^senior ·", re.I)).count() >= 1, "grid has separate Senior and Junior columns for the same date")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check(page.locator(".report-table tbody tr").count() == 22, "report has 22 rows")
    check(page.locator(".report-table th:has-text('UMPIRES')").count() == 5, "report headers match the emailed format, one table per section")
    page.click("a.tab:has-text('Allocate')")
    page.wait_for_selector("table.board")
    page.locator(".toggle:has-text('Published') input").check()

    print("Umpire: one page - appointments + season availability")
    sign_out(page)
    sign_in(page, "umpire1@demo.test")
    page.wait_for_selector(".tile")
    check(page.locator(".nav-link").count() == 0, "umpire header has no navigation links")
    check(page.locator("h2:has-text('My appointments')").count() == 1, "published appointments show on the same page")
    check(page.locator("li.appt a[href*='maps']").count() >= 1, "appointment links to a map")
    titles = page.locator(".comp-title").all_inner_texts()
    check(titles == ["Senior", "T20", "Junior"], f"one section per competition: {titles}")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    check(sen.locator(".drow").count() == 12, "Senior: 12 dates in one list")
    check(re.fullmatch(r"[A-Z][a-z]+ 20\d\d", sen.locator(".tile h3").first.inner_text()) is not None, "dates are grouped under month headings")
    labels = sen.locator(".dlabel").all_inner_texts()
    date_part = labels[0]
    check(re.fullmatch(r"[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}", date_part) is not None, f"row label is just the date: '{date_part}'")
    check(not any("Round" in t or "Day" in t for t in labels), "no round names or Day 1 / Day 2 text on the page")
    check(labels == sorted(labels, key=lambda t: sen.locator(".dlabel").all_inner_texts().index(t)) and sen.locator(".tile").first.inner_text().count(date_part) == 1, "dates appear once, in order")
    check(page.locator(".dlabel", has_text=date_part).count() >= 2, "the same date is listed under more than one competition (overlapping dates)")
    check(page.locator("button.opt").count() == 2 * page.locator(".drow").count(), "only two options per day (Available / Not available)")
    check(page.locator("text=Maybe").count() == 0 and page.locator("textarea").count() == 0, "no 'Maybe' option and no note box")
    check(page.locator(".chip:has-text('Submitted')").count() == 1, "'Submitted' chip is on the page (top right), no Edit step")
    sen_first = sen.locator(".drow").first
    jun_first = jun.locator(".drow", has_text=date_part).first
    check("on" in sen_first.locator("button.opt.yes").get_attribute("class"), "existing Senior answer is pre-highlighted")
    jun_before = jun_first.locator("button.opt.no").get_attribute("class")
    sen_first.locator("button.opt.no").click()
    check("on" in sen_first.locator("button.opt.no").get_attribute("class") and "on" not in sen_first.locator("button.opt.yes").get_attribute("class"), "tapping highlights the new choice only")
    check(jun_first.locator("button.opt.no").get_attribute("class") == jun_before, "changing Senior leaves the Junior answer for the same day alone")
    check(page.locator(".chip:has-text('Unsaved changes')").count() == 1, "chip warns about unsaved changes")
    page.click(".savebar button:has-text('Save')")
    page.wait_for_selector(".chip:has-text('Submitted')")
    check(True, "one Save updates the whole season and the chip returns to Submitted")
    page.reload()
    page.wait_for_selector(".tile")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    check("on" in sen.locator(".drow").first.locator("button.opt.no").get_attribute("class"), "answer is still there after reloading")
    check("on" in jun.locator(".drow", has_text=date_part).first.locator("button.opt.no").get_attribute("class"), "Junior 'not available' for the same day was kept separately")
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
    page.click(".savebar button:has-text('Save')")
    page.wait_for_selector(".chip:has-text('Submitted')")

    print("Admin sees the season-wide answers")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.locator(".card.round-card").first.click()
    page.wait_for_selector("table.board")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    heads = page.locator("table.board thead th").all_inner_texts()
    i_s = next(i for i, t in enumerate(heads) if t.lower().startswith("senior") and date_part.lower() in t.lower())
    i_j = next(i for i, t in enumerate(heads) if t.lower().startswith("junior") and date_part.lower() in t.lower())
    cells = page.locator("tr:has-text('Demo Umpire 1')").first.locator("td")
    check("ok" in cells.nth(i_s).get_attribute("class") and "no" in cells.nth(i_j).get_attribute("class"), "umpire 1 is available for Senior but not Junior on the same day")
    check(page.locator("text=Haven't replied (2)").count() == 1, "still two umpires with no reply")
    page.click("a.tab:has-text('Allocate')")

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

    API_DOWN = False
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

    print("Admin: sync season dates from Play Cricket (mocked)")
    page.goto(BASE + "#/admin")
    page.wait_for_selector("text=Season dates")
    page.click("button:has-text('Re-sync dates')")
    page.wait_for_selector("text=7 dates across 3 competition(s)")
    page.click("summary:has-text('Show the dates umpires see')")
    check(page.locator("li:has-text('Senior'):has-text('3 dates')").count() == 1, "Senior calendar: 3 dates (women's Saturday not counted twice)")
    check(page.locator("li:has-text('Junior'):has-text('3 dates')").count() == 1 and page.locator("li:has-text('T20'):has-text('1 dates')").count() == 1, "Junior and T20 dates are in the calendar too")
    check(page.locator("li", has_text="Round").count() == 0, "the season list shows dates only, no round names")

    print("New season: umpire sees the synced dates")
    sign_out(page)
    sign_in(page, "umpire2@demo.test")
    page.wait_for_selector(".tile")
    check(page.locator(".comp-title").all_inner_texts() == ["Senior", "T20", "Junior"], "umpire 2 sees Senior, T20 and Junior sections")
    check(page.locator(".drow").count() == 7, "umpire 2 sees the 7 synced dates")
    check(page.locator(".comp-section:has(h2:has-text('Junior')) .drow").count() == 3, "Junior: its 3 dates, even though U14 is two-day and U13 one-day")
    check(page.locator(".dnote").count() == 0 and page.locator(".comp-section").get_by_text("Round").count() == 0, "no round or note text on the page")
    check(page.locator(".dlabel", has_text=fmt_day_check()).count() == 1, "a date plays out as just the date")
    check(page.locator(".chip:has-text('Not submitted')").count() == 1, "a fresh season starts as 'Not submitted'")

    print("Mobile layout")
    m = ctx.new_page()
    m.set_viewport_size({"width": 390, "height": 800})
    m.goto(BASE + "#/")
    m.wait_for_selector(".tile")
    overflow = m.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
    check(not overflow, "availability page does not scroll sideways on a phone")
    check(m.locator(".savebar").is_visible(), "Save bar is visible without scrolling on a phone")

    print("Sample data pulls real fixtures when Play Cricket is reachable (mocked)")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector("text=real PDCA games")
    check(page.locator("text=Loaded 3 real PDCA games").count() == 1, "sample data uses the fixtures from the service (3 games in the next week)")
    page.click(".nav-link:has-text('Rounds')")
    page.locator(".round-card").first.click()
    page.wait_for_selector("table.board")
    check(page.locator("td:has-text('Kids Park') , td:has-text('Pearce Reserve')").count() >= 1, "board shows the real (mocked) grounds")

    browser.close()

httpd.shutdown()
print(f"\n{passed} checks passed")
real = [e for e in errors if not e.startswith("FAIL")]
if errors:
    print("\nProblems:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

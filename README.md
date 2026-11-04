# 🍔 Burger Truck Attendance

Clock-in / clock-out for food-truck staff, built for two constraints:

* **No electric device at the truck.** The truck only has a **printed paper QR poster**.
* **Employees may have no internet.** Their **own phone** records the punch offline and uploads it later.

## How it works

```
 Truck (paper only)          Employee phone (offline OK)                Server (owner)
┌───────────────┐  scan   ┌──────────────────────────────┐  when online ┌──────────────────┐
│  QR poster    │ ──────▶ │ time + GPS + poster code      │ ───────────▶ │ checks & stores   │
│  + backup code│         │ saved on phone, hash-chained  │   upload     │ dashboard + CSV   │
└───────────────┘         └──────────────────────────────┘              └──────────────────┘
```

1. The owner adds an employee in the dashboard and gets a **personal setup link/QR**.
2. The employee opens it **once with internet**, then adds the app to their home screen. From then on the app opens with no internet.
3. At the truck they tap **I ARRIVED** or **I'M LEAVING** and scan the poster. If the camera fails, they can type the 6-letter code printed under it.
4. The punch is saved on the phone with the time, GPS location (GPS works without internet) and the poster code. It uploads automatically the next time the phone has internet.
5. The owner sees daily arrival and leaving times, hours worked, a map link for every punch, and **warnings** for anything suspicious. Everything can be exported to CSV.

## Anti-cheating checks

The phone is the only device involved and the employee controls it, so nothing here is 100 % proof. The system makes cheating **visible** instead. Suspicious punches are kept with a warning label, never silently dropped.

| Trick | How it's caught |
|---|---|
| Clocking in from home | Must scan the poster. GPS is recorded, and a punch 300 m+ from where everyone else punched that day is flagged. |
| Photo of the poster | Click **Replace poster** and print a new one. Scans of the old poster are flagged. |
| Changing the phone clock | Time is compared to the server clock at upload (and the **estimated real time** is shown). Times that go backwards, or that fall before the current poster was printed, are flagged. |
| Editing or deleting saved punches | Each punch is SHA-256 hash-chained to the previous one. Edits and gaps are flagged. |
| Reinstalling the app / new phone | Flagged as "new phone". |

Dead phone? Page 2 of the printed poster is a **paper backup sheet**. The owner types those entries in by hand. They are labelled "by hand" and can be deleted.

## Run it

Requires **Node.js 22.13+** (uses the built-in SQLite). No other database is needed.

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

* Owner dashboard: `http://localhost:3000/admin/`. Log in with any username and your `ADMIN_PASSWORD`.
* Employee app: `http://localhost:3000/`, opened through each employee's setup link.

| Env var | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | random, printed at startup | dashboard password |
| `TRUCK_TZ` | `Africa/Cairo` | time zone for reports |
| `PORT` | `3000` | |
| `DB_FILE` | `attendance.db` | SQLite file (back it up!) |

### Deploying

The app must be served over **HTTPS**. Phones only allow the camera, GPS, offline mode and hashing on secure sites. Any small VPS or Node host with a persistent disk works (e.g. Caddy in front for automatic HTTPS, or Render/Railway/Fly with a volume for the DB file).

## Tests

```bash
npm test
```

Covers offline sync, idempotent re-upload, edit/delete/clock tampering, poster codes, location outliers and malformed input.

## Notes and limits

* **iPhone:** employees should use **Share → Add to Home Screen**. iOS may wipe saved data for websites that are not on the home screen and have not been used for a while.
* Punches show up for the owner only after the phone gets internet. If an employee never reconnects, the owner never sees those punches. "Last sync" on the Employees tab shows who hasn't uploaded recently.
* Someone could still clock in a friend by carrying the friend's phone. Adding a selfie per punch would be a possible next step.

# 🍔 Burger Truck Attendance

<div dir="rtl">

## بالعربي

نظام حضور وانصراف لعربة البرجر. **الواجهة كلها بالعربية.**

* **لا يوجد أي جهاز في العربة:** فقط ملصق QR مطبوع على ورق.
* **الموظف يسجّل من هاتفه:** يضغط «وصلت» أو «أنا ماشي» ثم يمسح الملصق. يعمل التسجيل **بدون إنترنت**، ويُرسَل تلقائياً عند توفر الإنترنت.
* **لوحة المالك** (`/admin/`): مواعيد الوصول والانصراف، وعدد الساعات، وموقع كل تسجيل على الخريطة، وتنبيهات للتلاعب (تغيير ساعة الهاتف، تسجيل من مكان بعيد، استخدام صورة لملصق قديم، حذف أو تعديل تسجيلات)، وتصدير Excel/CSV.
* **ورقة احتياطية** مطبوعة مع الملصق لمن نفد شحن هاتفه.

### الاستضافة المجانية (Cloudflare)

مجانية بالكامل، بدون بطاقة ائتمان، وتعمل على HTTPS تلقائياً:

1. أنشئ حساباً مجانياً على [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. ثبّت [Node.js](https://nodejs.org) (الإصدار 22 أو أحدث).
3. في مجلد المشروع شغّل:
   ```
   npm install
   npm run deploy:setup
   ```
   سيفتح المتصفح لتسجيل الدخول، ثم يطلب منك اختيار كلمة سر المالك.
4. ستحصل على رابط مثل `https://burger-truck-attendance.اسمك.workers.dev`، ولوحة المالك على `/admin/`.

للتحديث لاحقاً: `npm run deploy`. ولأخذ نسخة احتياطية من البيانات: `npm run backup`.

### تطبيق أندرويد (APK)

يوجد أيضاً تطبيق أندرويد (ملف APK) يفتح نفس الموقع بملء الشاشة وبأيقونة خاصة. أرسل ملف الـ APK للموظف (مثلاً على واتساب)، فيفتحه ويسمح بـ«تثبيت تطبيقات من مصادر غير معروفة» ثم يثبّته. **احتفظ بملف مفتاح التوقيع (`.jks`) وكلمة السر في مكان آمن**؛ بدونهما لا يمكن إصدار تحديثات للتطبيق.

</div>

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

## Free hosting (Cloudflare Workers + D1)

The app runs on Cloudflare's **free plan**. You get HTTPS automatically, it never sleeps, and no credit card is needed. A truck is far below the free limits (roughly 100,000 requests/day and a 5 GB database; one punch is a couple of requests).

1. Create a free account at https://dash.cloudflare.com/sign-up
2. Install [Node.js](https://nodejs.org) 22.13+.
3. In this folder:

   ```bash
   npm install
   npm run deploy:setup
   ```

   This logs you in (opens the browser), creates the database, creates the tables, deploys, and asks you to choose the **owner password**.
4. It prints your address, e.g. `https://burger-truck-attendance.<your-name>.workers.dev`. The owner dashboard is at `/admin/`.

Later:

| Command | |
|---|---|
| `npm run deploy` | publish code changes |
| `npx wrangler secret put ADMIN_PASSWORD` | change the owner password |
| `npm run backup` | download all data to `backup.sql` |

The time zone is set in `wrangler.toml` (`TRUCK_TZ`, default `Africa/Cairo`).

### Running it on your own computer or server instead

The same code also runs on plain Node with a local SQLite file:

```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start
```

| Env var | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | random, printed at startup | dashboard password |
| `TRUCK_TZ` | `Africa/Cairo` | time zone for reports |
| `PORT` | `3000` | |
| `DB_FILE` | `attendance.db` | SQLite file (back it up!) |

If you host it this way, it must be served over **HTTPS**. Phones only allow the camera, GPS and offline mode on secure sites.

To test the Cloudflare version locally: put `ADMIN_PASSWORD=...` in a `.dev.vars` file and run `npm run dev`.

### Code layout

| | |
|---|---|
| `public/` | employee phone app (PWA) and `public/admin/` owner dashboard |
| `src/app.js` | all HTTP routes (Hono), shared by both hosts |
| `src/worker.js` / `src/db-d1.js` | Cloudflare entry point and database |
| `src/server.js` / `src/db-node.js` | Node entry point and database |
| `src/sync.js` | checks every uploaded punch (anti-cheating) |
| `src/report.js` | daily summary, location outliers, CSV |
| `migrations/` | database tables |

## Android app (APK)

`android/` is a tiny Android app (a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity)). It opens the live site full-screen using Chrome's engine, with its own icon and no address bar. Everything else, including offline mode, camera and saved punches, is still the website. So **website updates reach the app automatically**, and the APK only needs rebuilding if the site address, icon or name changes.

* Package: `com.mustafaadel.burgertruck`. Needs Android 8+ and Chrome installed (it is on almost every Android phone).
* The site serves `/.well-known/assetlinks.json` (from `src/assetlinks.js`) with the **public** fingerprint of the signing key. That is what removes the address bar.
* The **signing key is not in this repo**. The owner keeps `burger-truck-release.jks` and its password. Every future APK must be signed with the same key, or phones will refuse the update.

Install on a phone: send the `.apk` (e.g. on WhatsApp), open it, allow "install unknown apps" when asked, then install. Open the app and tap **امسح كود الإعداد** to scan the employee's setup QR.

Rebuild (needs JDK 17+, Gradle 8.13+, and the Android SDK with `platforms;android-36` and `build-tools;36.0.0`):

```bash
cd android
export ANDROID_HOME=/path/to/android-sdk
export BTA_KEYSTORE=/path/to/burger-truck-release.jks
export BTA_KEYSTORE_PASSWORD='the password'
gradle assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

Bump `versionCode` in `android/app/build.gradle` for each new APK. If you ever change the domain, update `host` in `android/app/build.gradle` and re-sign.

## Tests

```bash
npm test
```

Covers offline sync, idempotent re-upload, edit/delete/clock tampering, poster codes, location outliers and malformed input.

## Notes and limits

* **iPhone:** employees should use **Share → Add to Home Screen**. iOS may wipe saved data for websites that are not on the home screen and have not been used for a while.
* Punches show up for the owner only after the phone gets internet. If an employee never reconnects, the owner never sees those punches. "Last sync" on the Employees tab shows who hasn't uploaded recently.
* Someone could still clock in a friend by carrying the friend's phone. Adding a selfie per punch would be a possible next step.

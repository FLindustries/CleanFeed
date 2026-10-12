# Chrome Web Store Listing — CleanFeed

> **Release gate (internal notes, not part of the listing: do not paste).**
> The price lines under FREE & PRO (EN) and GRATIS E PRO (IT) describe the plans ExtensionPay should sell once v1.4 ships. The extension itself shows whatever ExtensionPay's `getPlans()` returns, so the listing must say exactly what the dashboard sells. Before this listing is published or the ExtensionPay plans are changed:
>
> 1. **Currency: get an explicit "USD" or "EUR" from the owner.** On 2026-10-12 the owner wrote "il prezzo voglio che sia 2,99 €" and also "fai quello che mi raccomandi"; the v1.4 plan (Ruling 1, research section 4) chose USD. Change nothing in the dashboard until the answer is explicit. If EUR: ExtensionPay most likely uses one currency per extension, so every plan is in EUR and everyone pays in EUR. Rewrite both price lines in euro (EN "€2.99", IT "2,99 €"). The code needs no change: it reads the currency, so Italian shows no currency note and English shows "Prices in EUR."
> 2. **Dashboard first, listing second.** Publish the price lines only when the dashboard sells exactly: monthly 2.99 (interval month), yearly 19.99 (interval year), lifetime 29.99 (one-time). On 2026-10-12 it sells monthly 3.99 and yearly 29.99 USD, with no lifetime plan.
> 3. **Keep the nicknames `monthly`, `yearly` and `lifetime`** when repricing: each card's button opens `choose-plan/<nickname>`. Change the dashboard before v1.4 reaches users. In between, the store's v1.2.0 upgrade button still names 3.99 ("$3.99/mo", "3,99€/mese"): more than the new monthly price, never less. In v1.4 the plan picker refreshes plans older than a minute when it opens, and an answer with no plans is asked again after 5 minutes, so a half-edited dashboard does not stick. Only the popup's price line can lag up to 24 h.
> 4. **The lifetime launch price must really end.** For any one-time plan, the app shows "Launch price until December 31, 2026" through 2026-12-31 (each user's local date). Create the lifetime plan at the launch price only if it will really go up. Then raise it in the dashboard, keeping the nickname `lifetime`, once December 31 has ended in every time zone: on or after 2027-01-01 12:00 UTC (13:00 in Italy). Without that raise the note is false urgency. After the raise, update both price lines here: drop "launch price until ..." and state the new price.

## Short Description (132 chars max)

**EN:** Block channels permanently, filter by keyword & topic, and hide Shorts. Your YouTube, your rules.

**IT:** Blocca canali per sempre, filtra per keyword e argomento e nascondi gli Shorts. Il tuo YouTube, le tue regole.

---

## Detailed Description

**EN:**

CleanFeed gives you real control over what YouTube shows you.

BLOCK CHANNELS PERMANENTLY
Open any video's three-dot menu and choose "Block channel permanently", or use the Block button on a channel page or under a video. CleanFeed then hides that channel's videos on the homepage, in search, in the watch page sidebar and in Shorts, until you unblock it.

FILTER BY KEYWORD & TOPIC
Block whole topics (crypto, gambling, politics, gossip, gaming and 30 more) with a single toggle. Each topic also blocks related terms: blocking "crypto" also hides "bitcoin", "ethereum", "blockchain" and more. Add your own keywords too.

HIDE SHORTS
Hide Shorts shelves, Shorts in search results and the Shorts entry in YouTube's side menu with one toggle.

SMART FEATURES
- Per-term control: choose exactly which related terms each topic blocks
- Subscription exceptions: when a blocked keyword hides videos from channels you subscribe to, CleanFeed tells you (excluding those channels is a Pro feature)
- Hidden video log (Pro): see what was filtered and why
- Strict Mode (Pro): lock your filters behind a password, so weakening them needs the password
- Languages: English and Italian

FREE & PRO
Free: block unlimited channels, hide Shorts, and block up to 3 keywords or topics.
Pro: unlimited keywords and topics, Strict Mode password lock, hidden-videos log, and a whitelist for your subscribed channels.
Pro prices (USD): Monthly $2.99, Yearly $19.99 (= $1.67/mo, save 44%), Lifetime $29.99 one-time (launch price until Dec 31, 2026).

YOUR DATA STAYS ON YOUR DEVICE
Your block lists and settings are stored on your device. No analytics, no tracking, no ads. The only outside service is ExtensionPay, which checks whether you have paid for Pro.

---

**IT:**

CleanFeed ti da il vero controllo su cosa YouTube ti mostra.

BLOCCA I CANALI PERMANENTEMENTE
Apri il menu tre puntini di qualsiasi video e scegli "Blocca canale permanentemente", oppure usa il pulsante Blocca sulla pagina di un canale o sotto un video. CleanFeed nasconde poi i video di quel canale in homepage, nella ricerca, nella sidebar della pagina video e negli Shorts, finché non lo sblocchi.

FILTRA PER KEYWORD E ARGOMENTO
Blocca interi argomenti (crypto, gambling, politica, gossip, gaming e altri 30) con un solo toggle. Ogni argomento blocca anche i termini correlati: bloccare "crypto" nasconde anche "bitcoin", "ethereum", "blockchain" e altri. Aggiungi anche le tue keyword personalizzate.

NASCONDI GLI SHORTS
Nascondi con un toggle le sezioni Shorts, gli Shorts nei risultati di ricerca e la voce Shorts nel menu laterale di YouTube.

FUNZIONI SMART
- Controllo per termine: scegli esattamente quali termini correlati blocca ogni argomento
- Eccezioni iscrizioni: quando una keyword bloccata nasconde video di canali a cui sei iscritto, CleanFeed te lo dice (escludere quei canali è una funzione Pro)
- Log video nascosti (Pro): vedi cosa è stato filtrato e perché
- Modalità rigorosa (Pro): blocca i filtri con una password, per indebolirli serve la password
- Lingue: Inglese e Italiano

GRATIS E PRO
Gratis: blocco canali illimitato, nascondi Shorts e fino a 3 keyword o argomenti bloccati.
Pro: keyword e argomenti illimitati, blocco con password della modalità rigorosa, log dei video nascosti e whitelist per i canali a cui sei iscritto.
Prezzi Pro (in USD): mensile 2,99 USD, annuale 19,99 USD (= 1,67 USD/mese, risparmi il 44%), a vita 29,99 USD una tantum (prezzo di lancio fino al 31/12/2026).

I TUOI DATI RESTANO SUL TUO DISPOSITIVO
Liste di blocco e impostazioni sono salvate sul tuo dispositivo. Nessuna analisi, nessun tracciamento, nessuna pubblicità. L'unico servizio esterno è ExtensionPay, che verifica se hai pagato Pro.

---

## Category
Productivity (or: Fun)

## Language
English (primary), Italian

## Privacy Policy URL
https://flindustries.github.io/CleanFeed/privacy-policy.html

## Single Purpose Justification
CleanFeed has a single purpose: giving users control over their YouTube feed by blocking unwanted channels, keywords, topics, and Shorts.

## Host Permission Justification (youtube.com)
CleanFeed needs access to youtube.com to:
1. Read video titles, channel names, and description snippets to apply user-defined filters
2. Inject "Block channel" items into YouTube's video menus
3. Show its own controls on YouTube pages (Block button, pause switch, quick-add button)
4. Hide Shorts sections via CSS
CleanFeed's own scripts run only on youtube.com. The only other site is extensionpay.com, where ExtensionPay's script handles the Pro payment page.

## Permission Justification: storage
Saves the user's block lists and settings on their device (chrome.storage.local).

## Permission Justification: scripting
Chrome does not run an extension's content scripts in tabs that were already open when the extension was installed or updated. Right after an install or update, CleanFeed uses `scripting` to add its YouTube script and style sheet to the YouTube tabs that are already open, so filtering works there without a reload. It is used only on youtube.com tabs, only at install and update.

## Permission Justification: alarms
CleanFeed 1.4 creates no alarms. The permission is used only to remove the daily alarm that versions before 1.4.0 created.

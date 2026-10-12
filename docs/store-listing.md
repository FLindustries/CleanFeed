# CleanFeed v1.4.0: Chrome Web Store listing

## Release notes for the owner (do not paste)

- **Title:** final. EN 61 characters, IT 69 (limit 75). Identical to `extensionName` in `_locales/en/messages.json` and `_locales/it/messages.json`; the store takes the name from the uploaded package.
- **Short description:** final. EN 130 characters, IT 130 (limit 132). Identical to `extensionDescription` in the same two files.
- **Full description:** final, fact-checked against the code on `chore/v1.4-store-copy`. EN 2,498 characters, IT 2,780 (store limit 16,000). Plain text: paste each block as-is.
- **Prices:** live in ExtensionPay since 2026-10-12, in USD: Monthly $2.99, Yearly $19.99, Lifetime $29.99 one-time. The app reads its prices from ExtensionPay, so the descriptions must always match the dashboard.
- **REMINDER, Lifetime price:** on or after **2027-01-01 12:00 UTC** (13:00 in Italy), raise Lifetime to **$39.99** in the ExtensionPay dashboard, keeping the plan nickname `lifetime`. Then, in both full descriptions, remove the launch-price sentence ("(launch price until December 31, 2026)" and "(prezzo di lancio fino al 31 dicembre 2026)") and change 29.99 to 39.99. The app's own launch-price note stops by itself after December 31, 2026.
- **Before you submit:** upload a zip built from this commit or later (`bash package.sh`). The privacy policy at the URL below changes only after this branch is merged and GitHub Pages redeploys. Check what the ExtensionPay and Stripe dashboards show you about buyers, and fill in the store's privacy-practices form to match the privacy policy.

---

## EN Title

```
CleanFeed for YouTube: Block Channels & Keywords, Hide Shorts
```

## EN Short description

```
Hide videos from channels you block, filter titles by keyword or 35 ready-made topics, and remove Shorts. No account, no tracking.
```

## EN Full description

```
Clicked "Don't recommend channel" and it keeps coming back? Shorts everywhere? Topics you never want to see again?
CleanFeed hides them right inside YouTube.

WHAT IT DOES

Block channels
- A blocked channel's videos disappear from Home, search, Up next, channel pages, playlists and Shorts shelves.
- Also matched by @handle where shown, which helps when a channel is renamed.

Block keywords and 35 topics
- Hide videos by a word or phrase in the title (whole words only, accents included).
- Switch on a ready-made topic (Crypto, Gambling, Politics, Brainrot...) to filter all its related terms.

Hide Shorts and comments, tidy Subscriptions
- One switch removes Shorts from Home, Subscriptions, search and the sidebar.
- Hide comments and the algorithm-picked section in Subscriptions.

Tools right inside YouTube
- 3-dot menu: "Block channel permanently" (right after "Don't recommend channel") and "Not interested in this topic".
- A "Block this channel" button next to Subscribe.
- CF+: hover a video, click CF+ and pick words from its title to block.
- Scan: suggests recurring words from a channel page.

Stay in control
- Watch just now / Skip: click a video that matches a blocked word or topic and CleanFeed asks first.
- Show just now: see a blocked channel on one page without unblocking it.
- Pause filtering on a page from the top bar.
- Gaming, Tech, AI Hype, News and Sports let some analysis, history or documentary titles through.
- 3 videos from one channel hidden for the same topic? All its videos get hidden (auto-tag). Untag undoes it.
- Strict Mode (Pro): a password is needed to loosen your filters.

By design, blocks never apply to your Subscriptions feed.

FREE AND PRO
Free: unlimited channel blocking, 3 slots shared by keywords and topics, every tool above except Strict Mode.
Pro: unlimited keywords and topics, Strict Mode, a log of the last 100 hidden videos, exceptions for subscribed channels.
USD: $2.99/month, $19.99/year ($1.67/month, save 44%), or $29.99 one-time Lifetime (launch price until December 31, 2026).

PRIVACY
Lists and settings stay in your browser. No CleanFeed account, no analytics, no tracking. The only outside service is ExtensionPay (prices and payments). Runs only on youtube.com (and extensionpay.com for payments).

HOW TO START
1. Open YouTube.
2. Block a channel from a video's 3-dot menu.
3. Click the CleanFeed icon to turn on Hide Shorts or pick a topic.

SUPPORT
factuallogic98@gmail.com

Not affiliated with YouTube or Google.
```

---

## IT Title

```
CleanFeed per YouTube: blocca canali e parole chiave, nascondi Shorts
```

## IT Short description

```
Nascondi i video dei canali bloccati, filtra i titoli per parola o 35 argomenti, togli gli Shorts. Niente account né tracciamento.
```

## IT Full description

```
Hai cliccato "Non consigliare canale" ma il canale ricompare sempre? Shorts ovunque? Argomenti che non vuoi più vedere?
CleanFeed li nasconde dentro YouTube.

COSA FA

Blocca i canali
- I video di un canale bloccato spariscono da Home, ricerca, video successivi, pagine canale, playlist e scaffali Shorts.
- Riconosce il canale anche dall'@handle, se visibile: aiuta quando un canale cambia nome.

Blocca parole chiave e 35 argomenti
- Nascondi i video per parola o frase nel titolo (solo parole intere, accenti compresi).
- Attiva un argomento pronto (Crypto, Gambling, Politics, Brainrot...) per filtrare tutti i termini collegati.

Nascondi Shorts, commenti e "Più pertinenti"
- Un interruttore toglie gli Shorts da Home, Iscrizioni, ricerca e menu laterale.
- Nascondi i commenti e la sezione "Più pertinenti" nel feed Iscrizioni.

Strumenti dentro YouTube
- Menu a 3 puntini: "Blocca canale permanentemente" (subito dopo "Non consigliare canale") e "Non mi interessa questo argomento".
- Il pulsante "Blocca questo canale" accanto a Iscriviti.
- CF+: passa il mouse su un video, clicca CF+ e scegli le parole del titolo da bloccare.
- Scan: suggerisce le parole ricorrenti dalla pagina di un canale.

Il controllo resta tuo
- Guarda solo ora / Salta: clicchi un video con una parola o un argomento bloccato? CleanFeed prima te lo chiede.
- Mostra ora: vedi un canale bloccato su una sola pagina, senza sbloccarlo.
- Metti in pausa il filtro su una pagina dalla barra in alto.
- Gaming, Tech, AI Hype, News e Sports lasciano passare alcuni titoli di analisi, storia o documentari.
- 3 video di un canale nascosti per lo stesso argomento? Spariscono tutti i suoi video (etichetta automatica). "Togli etichetta" li fa tornare.
- Modalità rigorosa (Pro): per allentare i filtri serve una password.

Per scelta, i blocchi non valgono mai nel feed Iscrizioni.

GRATIS E PRO
Gratis: blocco canali illimitato, 3 posti condivisi tra parole chiave e argomenti, ogni strumento sopra tranne la Modalità rigorosa.
Pro: parole chiave e argomenti illimitati, Modalità rigorosa, registro degli ultimi 100 video nascosti, eccezioni per i canali a cui sei iscritto.
Prezzi in USD: 2,99/mese, 19,99/anno (1,67/mese, risparmi il 44%) o 29,99 una tantum per la licenza a vita (prezzo di lancio fino al 31 dicembre 2026).

PRIVACY
Liste e impostazioni restano nel browser. Nessun account CleanFeed, niente statistiche o tracciamento. L'unico servizio esterno è ExtensionPay (prezzi e pagamenti). Funziona solo su youtube.com (e su extensionpay.com per i pagamenti).

COME INIZIARE
1. Apri YouTube.
2. Blocca un canale dal menu a 3 puntini di un video.
3. Dall'icona di CleanFeed attiva Nascondi Shorts o scegli un argomento.

SUPPORTO
factuallogic98@gmail.com

Non affiliata a YouTube né a Google.
```

---

## Other dashboard fields

**Category:** Productivity

**Language:** English (primary), Italian

**Privacy policy URL:** https://flindustries.github.io/CleanFeed/privacy-policy.html

**Single purpose:** CleanFeed has a single purpose: giving users control over their YouTube feed by blocking unwanted channels, keywords, topics, and Shorts.

**Host permission justification (youtube.com):**
CleanFeed needs access to youtube.com to:
1. Read video titles, channel names, and description snippets to apply user-defined filters
2. Inject "Block channel" items into YouTube's video menus
3. Show its own controls on YouTube pages (Block button, pause switch, quick-add button)
4. Hide Shorts sections via CSS
CleanFeed's own scripts run only on youtube.com. The only other site is extensionpay.com, where ExtensionPay's script handles the Pro payment page.

**Permission justification, storage:** Saves the user's block lists and settings on their device (chrome.storage.local). The bundled ExtensionPay library also uses chrome.storage.sync for its install date, license key and payment record.

**Permission justification, scripting:** Chrome does not run an extension's content scripts in tabs that were already open when the extension was installed or updated. Right after an install or update, CleanFeed uses `scripting` to add its YouTube script and style sheet to the YouTube tabs that are already open, so filtering works there without a reload. It is used only on youtube.com tabs, only at install and update.

**Permission justification, alarms:** CleanFeed 1.4 creates no alarms. The permission is used only to remove the daily alarm that versions before 1.4.0 created.

// CleanFeed Strict Mode client: the one copy of the password retry logic.
// Loaded by popup.html and options.html only. Never load it in a content
// script: CleanFeed does not ask for a password inside YouTube pages.
//
// While strict mode is on, the background answers a request that weakens
// filtering with { error: 'strict_locked' } unless it carries the right
// strictPassword.

// Returns sendWithStrict(request) for one page. getMessage is the page's own
// message helper (msg in options.js, cfMsg in popup.js).
// sendWithStrict sends the request; on strict_locked it asks for the password,
// retries with it and remembers it once accepted. The password lives in this
// closure for the page's lifetime only and is never stored. It resolves to the
// background's response (still strict_locked if cancelled or wrong).
function cfCreateStrictSender(getMessage) {
  let strictPassword = '';

  const text = (key, fallback) => {
    const s = getMessage(key);
    return s && s !== key ? s : fallback;
  };

  return async function sendWithStrict(request) {
    let res = await chrome.runtime.sendMessage(strictPassword ? { ...request, strictPassword } : request);
    if (res?.error !== 'strict_locked') return res;
    // A remembered password can stop working (changed on another page).
    strictPassword = '';
    const pwd = prompt(text('strictRequiresPassword', 'Strict mode is enabled. Enter password to continue:'));
    if (!pwd) return res;
    res = await chrome.runtime.sendMessage({ ...request, strictPassword: pwd });
    if (res?.error === 'strict_locked') alert(text('strictWrongPassword', 'Wrong password.'));
    else strictPassword = pwd;
    return res;
  };
}

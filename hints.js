const css = `
  :root {
      --KEYJUMP-color-text: #000;
      --KEYJUMP-color-bg: cyan;
      --KEYJUMP-color-bg: cyan;
      --KEYJUMP-color-border: cyan;
      --KEYJUMP-zindex: 99999999999999999999;
  }

  .KEYJUMP {
      position: fixed;
      top: 0;
      left: 0;
      z-index: var(--KEYJUMP-zindex);
      opacity: 0;
      pointer-events: none;
  }

  .KEYJUMP_active {
      opacity: 1;
  }

  .KEYJUMP_hint {
      position: absolute;
      padding: 4px 6px;
      color: var(--KEYJUMP-color-text);
      background: var(--KEYJUMP-color-bg);
      box-shadow: var(--KEYJUMP-shadow-highlight),
          var(--KEYJUMP-shadow-drop);
      font:
          bold 14px/1 "Helvetica Neue",
          Helvetica,
          Arial,
          sans-serif;
      letter-spacing: 1px;
      white-space: nowrap;
    //   visibility: hidden;
  }

  .KEYJUMP_filtered .KEYJUMP_hint {
      opacity: 0;
  }

  .KEYJUMP_filtered .KEYJUMP_match {
      opacity: 1;
  }
`;

/* globals _browser */
// boostrap-state
// `browser` is the standardised interface for Web Extensions, but Chrome
// doesn't support that yet.
// const _browser = typeof browser !== "undefined" ? browser : chrome;
const _browser = {
    runtime: {}
};

// Workaround until dynamic imports are supported in browser extensions in all
// browsers.
const KJ = (window.__KEYJUMP__ = window.__KEYJUMP__ || {});
KJ.bootstrapState = function bootstrapState(state = {}, callback) {
    let gotInfo = false;
    let gotOptions = false;

    // Not available in content script.
    if (_browser.runtime.getPlatformInfo) {
        _browser.runtime.getPlatformInfo(getInfoCallback);
    } else {
        getInfoCallback({
            // Only need to know if Mac in the content script.
            os: navigator.platform.toLowerCase().includes("mac") ? "mac" : "unknown",
        });
    }

    function getInfoCallback(info) {
        state.os = info.os;
        gotInfo = true;
        runCallbackIfDone();
    }

    // _browser.storage.sync.get(null, (options) => {
    state.options = processOptions({});
    gotOptions = true;
    runCallbackIfDone();
    // });

    function runCallbackIfDone() {
        if (gotInfo && gotOptions) {
            callback(state);
        }
    }
};

function processOptions(options) {
    const defaultOptions = {
        optionsVersion: 3,
        activationShortcut: {
            key: ",",
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
        },
        newTabActivationShortcut: {
            key: ".",
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
        },
        autoTrigger: true,
        activateNewTab: true,
        ignoreWhileInputFocused: true,
    };

    let saveOptions = false;

    if (!options) {
        saveOptions = true;
        options = defaultOptions;
    }
    if (options.optionsVersion === 1) {
        saveOptions = true;
        options.optionsVersion = 2;
        options.activateNewTab = true;
    }
    if (options.optionsVersion === 2) {
        saveOptions = true;
        options.optionsVersion = 3;
        options.ignoreWhileInputFocused = true;
    }
    if (options.optionsVersion !== defaultOptions.optionsVersion) {
        saveOptions = true;
        options = defaultOptions;
    }

    // Save options even if they have not been changed so if we change the
    // defaults in the future we don't necessarily have to change them for
    // existing users who might have become used to the old default behaviour.
    // if (saveOptions) {
    // _browser.storage.sync.set(options);
    // }

    return options;
}

// Initialize

const state = {
    // Since we want to handle the events as soon as possible we inject this
    // extension's content script using `"run_at": "document_start"` which will
    // be before the `document.body` element is available, so we use
    // `document.documentElement` instead as the root element.
    //
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts#run_at
    rootEl: document.documentElement,
    active: false,
    openInNewTab: null,
    hints: [],
    query: "",
    matchingHint: null,
    delayedCleanupCallback: null,
    removeRefreshHintsEventListeners: null,
    renderCache: null,
};

window.__KEYJUMP__.bootstrapState(state, setup);

// Stuff

const classNames = Object.freeze({
    container: "KEYJUMP",
    hint: "KEYJUMP_hint",
    active: "KEYJUMP_active",
    filtered: "KEYJUMP_filtered",
    match: "KEYJUMP_match",
});

function setup() {
    // We want to handle the events as soon as possible so listen for them
    // on `window` because that's where the event propagation starts.
    //
    // We also want to handle the events as soon as possible so use the
    // capturing event phase because it is handled first.
    //
    // http://www.w3.org/TR/uievents/#event-flow
    window.addEventListener("keydown", keyboardEventCallback, true);
    window.addEventListener("keyup", keyboardEventCallback, true);
    // add css
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
}

function keyboardEventCallback(event) {
    if (
        !event.repeat &&
        !(
            state.options.ignoreWhileInputFocused && canElementBeTypedIn(event.target)
        )
    ) {
        if (event.type === "keydown") {
            handleKeydown(event);
        } else if (event.type === "keyup") {
            handleKeyup(event);
        }
    }
}

function canElementBeTypedIn(el) {
    // Unknown input types are treated as text inputs so it's easier to test
    // for the types that we know can't be typed in.
    const typesYouCantTypeIn = [
        "button",
        "checkbox",
        "color",
        "file",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
    ];
    const tagName = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const typeCanBeTypedIn = !typesYouCantTypeIn.includes(type);

    return (
        el.isContentEditable ||
        (!el.readOnly &&
            (tagName === "textarea" || (tagName === "input" && typeCanBeTypedIn)))
    );
}

function handleKeydown(event) {
    const isActivationShortcut = doesEventMatchShortcut(
        event,
        state.options.activationShortcut,
    );

    const isNewTabActivationShortcut = doesEventMatchShortcut(
        event,
        state.options.newTabActivationShortcut,
    );

    if (shouldMatchingHintBeTriggered(event)) {
        // The keydown event should only be stopped, the keyup event is used for
        // triggering, because if we focus the target element on keydown there will
        // be a keyup event on the target element and that's annoying to deal with.
        stopKeyboardEvent(event);
    } else if (isActivationShortcut || isNewTabActivationShortcut) {
        handleActivationKey(event);
    } else if (state.active && !eventHasModifierKey(event)) {
        if (event.key === "Escape") {
            handleEscapeKey(event);
        } else {
            console.log("# handleQueryKey");
            const allowedQueryCharacters = [
                'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm',
                'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
                '1', '2', '3', '4', '5', '6', '7', '8', '9', 'aa', 'bb', 'cc',
                'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'mm', 'nn',
                'oo', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'ww', 'xx', 'yy',
                'zz', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
                '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31',
                '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42',
                '43', '44', '45', '46', '47', '48', '49', '50', '51', '52', '53',
                '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64',
                '65', '66', '67', '68', '69', '70', '71', '72', '73', '74', '75',
                '76', '77', '78', '79', '80', '81', '82', '83', '84', '85', '86',
                '87', '88', '89', '90', '91', '92', '93', '94', '95', '96', '97',
                '98', '99'
            ];

            if (allowedQueryCharacters.includes(event.key)) {
                handleQueryKey(event);
            }
        }
    }
}

function handleKeyup(event) {
    if (shouldMatchingHintBeTriggered(event)) {
        // Use keyup for triggering, because if we focus the target
        // element on keydown there will be a keyup event on the
        // target element and that's annoying to deal with.
        stopKeyboardEvent(event);
        triggerMatchingHint();
    }
}

function doesEventMatchShortcut(event, shortcut) {
    return (
        event.key === shortcut.key &&
        event.shiftKey === shortcut.shiftKey &&
        event.ctrlKey === shortcut.ctrlKey &&
        event.altKey === shortcut.altKey &&
        event.metaKey === shortcut.metaKey
    );
}

function shouldMatchingHintBeTriggered(event) {
    return !!(event.key === "Enter" && state.matchingHint);
}

function stopKeyboardEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function eventHasModifierKey(event) {
    return !!(event.shiftKey || event.ctrlKey || event.altKey || event.metaKey);
}

function handleActivationKey(event) {
    const isNewTabActivationShortcut = doesEventMatchShortcut(
        event,
        state.options.newTabActivationShortcut,
    );

    stopKeyboardEvent(event);

    if (state.active) {
        if (state.openInNewTab !== isNewTabActivationShortcut) {
            state.openInNewTab = isNewTabActivationShortcut;
        } else {
            deactivateHintMode();
        }
    } else {
        console.log("activateHintMode");
        state.openInNewTab = isNewTabActivationShortcut;
        activateHintMode();
    }
}

function handleEscapeKey(event) {
    stopKeyboardEvent(event);

    if (state.query) {
        state.query = "";
        state.matchingHint = null;
        clearFilterFromHints();
    } else {
        deactivateHintMode();
    }
}

function handleQueryKey(event) {
    // Don't allow leading 0 in query.
    console.log("# handleQueryKey", event.key);
    if (state.query === "" && event.key === "0") {
        return;
    }

    stopKeyboardEvent(event);

    const newQuery = state.query + event.key;
    const choices = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '1', '2', '3', '4', '5', '6', '7', '8', '9', 'aa', 'bb', 'cc',
        'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'mm', 'nn',
        'oo', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'ww', 'xx', 'yy',
        'zz', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
        '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31',
        '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42',
        '43', '44', '45', '46', '47', '48', '49', '50', '51', '52', '53',
        '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64',
        '65', '66', '67', '68', '69', '70', '71', '72', '73', '74', '75',
        '76', '77', '78', '79', '80', '81', '82', '83', '84', '85', '86',
        '87', '88', '89', '90', '91', '92', '93', '94', '95', '96', '97',
        '98', '99'
    ];
    const index = choices.indexOf(newQuery);
    const newMatchByIndex = state.hints[index];
    if (newMatchByIndex) {
        console.log("# newMatchByIndex");
        state.query = newQuery;
        state.matchingHint = newMatchByIndex;
        console.log("# state.matchingHint", state.matchingHint);
        filterHints();

        if (
            state.options.autoTrigger
            // Now we check if it's possible to match another hint by appending
            // another digit to the query. For example if the query is 1 and there are
            // 15 hints then you could match hints 10-15 by appending 0-5 to the
            // query.
            //
            // To do the check we first multiply the query with 10 because that will
            // append a 0 to the end of the query, the lowest number that can be
            // appended. Then we check if there are fewer hints than the new query, in
            // which case no more matches can be made and we can autotrigger the
            // current match.
            //
            // Assume that there are 15 hints, then:
            // * Query = 1, Query * 10 = 10, and since 10 is less than 15 we know that
            //   you could match hints 10-15 by appending 0-5 to the query.
            // * Query = 2, Query * 10 = 20, and since 20 is more than 15 we know that
            //   you can't match any other hints by appending another digit to the
            //   query.
            // state.hints.length < newQueryAsInt * 10
        ) {
            triggerMatchingHint();
        }
    }
}

function triggerMatchingHint() {
    // Stop refreshing before triggering because the triggering could cause a
    // refresh, for example when triggering a fragment link and the page scrolls,
    // and that breaks the clean-up when deactivating.
    state.removeRefreshHintsEventListeners();

    const {
        matchingHint: { targetEl },
        openInNewTab,
    } = state;

    if (shouldElementBeFocused(targetEl)) {
        targetEl.focus();
    } else {
        if (
            openInNewTab &&
            // Is a link.
            targetEl.tagName.toLowerCase() === "a" &&
            // Has a href value.
            targetEl.getAttribute("href")
        ) {
            console.log(`@@@ send message`);
            _browser.runtime.sendMessage({ openUrlInNewTab: targetEl.href });
        } else {
            const mouseEvent = new MouseEvent("click", {
                view: window,
                bubbles: true,
                cancelable: true,
            });

            targetEl.dispatchEvent(mouseEvent);
        }
    }

    // Deactivation is done after the triggering is complete since it resets the
    // hints stuff in the state, which we need when triggering.
    deactivateHintMode();
}

function activateHintMode() {
    findHints();

    if (!state.hints.length) {
        return;
    }

    state.active = true;
    renderHints();
    state.renderCache.containerEl.classList.add(classNames.active);

    // If someone is repeatedly pressing the (de)activation key so fast
    // that the hiding animation won't have time to finish we have to
    // trigger the callback ourselves here.
    if (state.delayedCleanupCallback) {
        state.delayedCleanupCallback();
    }

    const refreshHintsHandler = refreshHintsFactory();

    document.addEventListener("scroll", refreshHintsHandler);
    window.addEventListener("resize", refreshHintsHandler);
    window.addEventListener("popstate", refreshHintsHandler);

    state.removeRefreshHintsEventListeners =
        function removeRefreshHintsEventListeners() {
            document.removeEventListener("scroll", refreshHintsHandler);
            window.removeEventListener("resize", refreshHintsHandler);
            window.removeEventListener("popstate", refreshHintsHandler);

            // Removes itself so it can't be called multiple times, and to clean up
            // memory usage.
            state.removeRefreshHintsEventListeners = null;
        };
    surflyExtension.surflySession.apiRequest({cmd: 'send_chat_message', message: `✨ Agent: Activating hints mode..`});
}

function deactivateHintMode() {
    if (state.removeRefreshHintsEventListeners) {
        state.removeRefreshHintsEventListeners();
    }

    // We have to wait for the opacity transition to end before we can
    // clean things up.
    state.delayedCleanupCallback = delayedCleanupFactory();
    state.renderCache.containerEl.addEventListener(
        "transitionend",
        state.delayedCleanupCallback,
    );

    state.renderCache.containerEl.classList.remove(classNames.active);

    state.active = false;
    state.hints = [];
    state.query = "";
    state.matchingHint = null;


    // Webfuse: Reactivate the hints mode after 2 seconds
    setTimeout(() => {
        activateHintMode();
    }, 2000);
}

function filterHints() {
    state.renderCache.containerEl.classList.add(classNames.filtered);

    for (const hint of state.hints) {
        const method = hint.id.startsWith(state.query) ? "add" : "remove";
        hint.hintEl.classList[method](classNames.match);
    }
}

function shouldElementBeFocused(el) {
    const tagName = el.tagName.toLowerCase();
    const inputType = (el.type || "").toLowerCase();

    // Inputs that should be clicked, like checkbox, can also have their
    // readOnly property set to true, but it does not disable them, and
    // they should still be clicked, so the check has to account for that.
    // TODO: Maybe refactor `canElementBeTypedIn` into something new?

    // Select elements can no longer be opened by using the 'mousedown' event
    // since Chrome implemented Event.isTrusted so now we just focus them instead.
    return (
        tagName === "select" ||
        (tagName === "input" && inputType === "range") ||
        canElementBeTypedIn(el)
    );
}

function clearFilterFromHints() {
    state.renderCache.containerEl.classList.remove(classNames.filtered);

    for (const { hintEl } of state.hints) {
        hintEl.classList.remove(classNames.match);
    }
}

function findHints() {
    const targetEls = state.rootEl.querySelectorAll(
        [
            // Don't search for 'a' to avoid finding elements used only for fragment
            // links (jump to a point in a page) which sometimes mess up the hint
            // numbering or it looks like they can be clicked when they can't.
            "a[href]",
            "input:not([disabled]):not([type=hidden])",
            "textarea:not([disabled])",
            "select:not([disabled])",
            "button:not([disabled])",
            "[contenteditable]:not([contenteditable=false]):not([disabled])",
            "[ng-click]:not([disabled])",
            // GWT Anchor widget class
            // http://www.gwtproject.org/javadoc/latest/com/google/gwt/user/client/ui/Anchor.html
            ".gwt-Anchor",
        ].join(","),
    );

    const choices = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '1', '2', '3', '4', '5', '6', '7', '8', '9', 'aa', 'bb', 'cc',
        'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'mm', 'nn',
        'oo', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'ww', 'xx', 'yy',
        'zz', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
        '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31',
        '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42',
        '43', '44', '45', '46', '47', '48', '49', '50', '51', '52', '53',
        '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64',
        '65', '66', '67', '68', '69', '70', '71', '72', '73', '74', '75',
        '76', '77', '78', '79', '80', '81', '82', '83', '84', '85', '86',
        '87', '88', '89', '90', '91', '92', '93', '94', '95', '96', '97',
        '98', '99'
    ];
    let hintIndex = 0;

    state.hints = [];

    for (const el of targetEls) {
        if (isElementVisible(el)) {
            state.hints.push({
                id: choices[hintIndex],
                targetEl: el,
            });

            hintIndex++;
        }

        if (hintIndex === choices.length) {
            break;
        }
    }
}

function renderHints() {
    if (!state.hints.length) {
        return;
    }

    if (!state.renderCache) {
        setupRendering();
    }

    const { renderCache: cache } = state;

    const fragment = document.createDocumentFragment();
    const winHeight = document.documentElement.clientHeight;

    for (const hint of state.hints) {
        hint.hintEl = cache.hintSourceEl.cloneNode(true);
        hint.hintEl.textContent = hint.id;

        fragment.appendChild(hint.hintEl);

        // TODO: Refactor to find the first visible child element instead of rect.
        // We must check both the element rect and styles to see if it is visible.
        const rects = hint.targetEl.getClientRects();
        // If none of the rects are visible use the first rect as a workaround...
        const targetPos = Array.from(rects).find(isRectVisible) || rects[0];
        const hintCharWidth = cache.hintCharWidth * hint.id.length;

        const top = Math.max(
            0,
            Math.min(Math.round(targetPos.top), winHeight - cache.hintHeight),
        );
        const left = Math.max(
            0,
            Math.round(targetPos.left - cache.hintWidth - hintCharWidth - 2),
        );

        hint.hintEl.style.top = top + "px";
        hint.hintEl.style.left = left + "px";
    }

    cache.containerEl.appendChild(fragment);
}

function refreshHintsFactory() {
    function refreshHints() {
        if (state.hints.length) {
            removeHints(state.hints);
        }

        findHints();

        if (!state.hints.length) {
            return;
        }

        renderHints();

        if (state.query) {
            filterHints();
        }
    }

    return function debouncedRefreshHints(event) {
        cancelAnimationFrame(state.refreshHintsRAF);
        state.refreshHintsRAF = requestAnimationFrame(refreshHints);

        // Sometimes the page change is a bit slow and the refresh has happened
        // before the page changes, so refresh again after a timeout to hopefully
        // catch those cases.
        if (event.type === "popstate") {
            clearTimeout(state.refreshHintsTimeout);
            state.refreshHintsTimeout = setTimeout(refreshHints, 350);
        }
    };
}

function delayedCleanupFactory() {
    const { hints } = state;

    return function delayedCleanup() {
        state.renderCache.containerEl.removeEventListener(
            "transitionend",
            state.delayedCleanupCallback,
        );
        state.delayedCleanupCallback = null;

        removeHints(hints);
        state.renderCache.containerEl.classList.remove(classNames.filtered);
    };
}

function isElementVisible(el) {
    let rect = el.getBoundingClientRect();

    // Only check if the initial element is in the viewport since it could be
    // positioned outside its parent elements which themselves could be outside
    // the viewport.
    if (!isRectInViewport(rect)) {
        return false;
    }

    // These overflow values will hide the overflowing child elements.
    const hidingOverflows = ["hidden", "auto", "scroll"];
    const allowedCollapsedTags = ["html", "body"];

    while (el) {
        const styles = window.getComputedStyle(el);

        if (
            // prettier-ignore
            styles.display === 'none' ||
            styles.visibility === 'hidden' ||
            styles.opacity === '0' ||
            (
                (
                    (rect.width <= 0 && hidingOverflows.includes(styles['overflow-x'])) ||
                    (rect.height <= 0 && hidingOverflows.includes(styles['overflow-y']))
                ) &&
                !allowedCollapsedTags.includes(el.tagName.toLowerCase())
            )
        ) {
            return false;
        }

        el = el.parentElement;

        if (el) {
            rect = el.getBoundingClientRect();
        }
    }

    return true;
}

function isRectVisible(rect) {
    // TODO: BUG
    // This will report false even if the element the rect is for has a visible
    // overflow which means that the content is still visible even though the
    // element has 0 width/height.
    return isRectInViewport(rect) && rect.width > 0 && rect.height > 0;
}

function isRectInViewport(rect) {
    if (
        !rect ||
        rect.top >= document.documentElement.clientHeight ||
        rect.left >= document.documentElement.clientWidth ||
        rect.bottom <= 0 ||
        rect.right <= 0
    ) {
        return false;
    }

    return true;
}

function setupRendering() {
    const cache = (state.renderCache = {});

    cache.containerEl = document.createElement("div");
    cache.containerEl.classList.add(classNames.container);
    state.rootEl.appendChild(cache.containerEl);

    cache.hintSourceEl = document.createElement("div");
    cache.hintSourceEl.classList.add(classNames.hint);

    const hintDimensionsEl = cache.hintSourceEl.cloneNode(true);
    cache.containerEl.appendChild(hintDimensionsEl);

    cache.hintWidth = hintDimensionsEl.offsetWidth;
    hintDimensionsEl.innerHTML = "0";
    cache.hintHeight = hintDimensionsEl.offsetHeight;
    cache.hintCharWidth = hintDimensionsEl.offsetWidth - cache.hintWidth;

    cache.containerEl.removeChild(hintDimensionsEl);
}

function removeHints(hints) {
    for (const { hintEl } of hints) {
        hintEl.parentNode.removeChild(hintEl);
    }
}

window.setup = setup;
window.activateHintMode = activateHintMode;
window.deactivateHintMode = deactivateHintMode;
window.handleKeydown = handleKeydown;
window.handleKeyup = handleKeyup;
window.doesEventMatchShortcut = doesEventMatchShortcut;
window.shouldMatchingHintBeTriggered = shouldMatchingHintBeTriggered;
window.stopKeyboardEvent = stopKeyboardEvent;
window.eventHasModifierKey = eventHasModifierKey;
window.handleActivationKey = handleActivationKey;
window.handleEscapeKey = handleEscapeKey;
window.handleQueryKey = handleQueryKey;
window.triggerMatchingHint = triggerMatchingHint;

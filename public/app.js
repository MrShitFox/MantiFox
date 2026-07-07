(function () {
  'use strict';

  /* ==================================================================== *
   *  State initialisation.
   *  enhance() is idempotent and runs on first load, after every htmx
   *  swap, and after history restores, so JS-dependent widgets keep
   *  working inside swapped-in fragments — never bind on load only.
   * ==================================================================== */

  function enhance(root) {
    forEachMatch(root, '.connection-form', syncAuthFields);
    forEachMatch(root, '[data-column-row], .add-column-form', syncColumnKind);
  }

  function forEachMatch(root, selector, fn) {
    if (!root) return;
    if (root.nodeType === 1 && root.matches(selector)) fn(root);
    if (root.querySelectorAll) root.querySelectorAll(selector).forEach(fn);
  }

  document.addEventListener('DOMContentLoaded', function () {
    enhance(document.body);
    observeToasts();
  });

  document.addEventListener('htmx:historyRestore', function () {
    enhance(document.body);
  });

  // htmx fires htmx:load for every batch of new content it settles (including
  // history-miss restores) — cheap insurance on top of afterSwap since
  // enhance() is idempotent.
  document.addEventListener('htmx:load', function (event) {
    if (event.detail && event.detail.elt instanceof Element) enhance(event.detail.elt);
  });

  /* --- auth type toggle (connection form) --- */

  function syncAuthFields(form) {
    var select = form.querySelector('[name="auth_type"]');
    if (!select) return;
    form.querySelectorAll('.auth-basic').forEach(function (node) {
      node.hidden = select.value !== 'basic';
    });
    form.querySelectorAll('.auth-bearer').forEach(function (node) {
      node.hidden = select.value !== 'bearer';
    });
  }

  /* --- column kind toggle (create table / add column forms) --- */

  function syncColumnKind(row) {
    var select = row.querySelector('[data-column-type]');
    if (!select) return;
    var type = select.value;
    var indexed = row.querySelector('input[name$="indexed"]');
    var stored = row.querySelector('input[name$="stored"]');
    if (type === 'string' && indexed && stored && indexed.checked && stored.checked) {
      stored.checked = false;
    }
    row.querySelectorAll('.column-modifier').forEach(function (node) {
      node.hidden = type !== 'text' && type !== 'string';
    });
    row.querySelectorAll('.json-option').forEach(function (node) {
      node.hidden = type !== 'json';
    });
    row.querySelectorAll('.vector-options').forEach(function (node) {
      node.hidden = type !== 'float_vector';
    });
  }

  /* ==================================================================== *
   *  Delegated events — they survive any fragment swap.
   * ==================================================================== */

  document.addEventListener('change', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.matches('[name="auth_type"]')) {
      var form = target.closest('form');
      if (form) syncAuthFields(form);
    }
    if (target.matches('[data-column-type]')) {
      var row = target.closest('[data-column-row], .add-column-form');
      if (row) syncColumnKind(row);
    }
  });

  /* --- a SQL preview goes stale as soon as its form changes --- */

  function invalidatePreview(event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var form = target.closest('form[data-preview-guard]');
    if (!form || target.name === 'sql_preview') return;
    disableExecute(form);
  }

  document.addEventListener('input', invalidatePreview);
  document.addEventListener('change', invalidatePreview);

  function disableExecute(form) {
    var execute = form.querySelector('button[name="intent"][value="execute"]');
    if (execute) execute.disabled = true;
  }

  /* --- clicks: column builder rows, toast dismissal --- */

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    var addButton = target.closest('[data-add-column]');
    if (addButton) {
      var form = addButton.closest('form');
      var list = form && form.querySelector('[data-column-list]');
      var countInput = form && form.querySelector('[data-column-count]');
      if (!list || !countInput) return;
      var index = Number.parseInt(countInput.value || '0', 10) || 0;
      list.insertAdjacentHTML('beforeend', createColumnRowHtml(index));
      countInput.value = String(index + 1);
      var added = list.lastElementChild;
      if (added) {
        syncColumnKind(added);
        added.classList.add('entering');
        added.addEventListener('animationend', function () {
          added.classList.remove('entering');
        }, { once: true });
        var nameInput = added.querySelector('input[name$="_name"]');
        if (nameInput) nameInput.focus();
      }
      disableExecute(form);
      return;
    }

    var removeButton = target.closest('[data-remove-column]');
    if (removeButton) {
      var row = removeButton.closest('[data-column-row]');
      var ownerForm = removeButton.closest('form');
      if (row) {
        row.classList.add('removing');
        row.addEventListener('animationend', function () {
          row.remove();
        }, { once: true });
      }
      if (ownerForm) disableExecute(ownerForm);
      return;
    }

    var toastClose = target.closest('[data-toast-close]');
    if (toastClose) {
      dismissToast(toastClose.closest('.toast'));
    }
  });

  /* --- capture-phase submit guard: JSON validation + destructive confirm.
         preventDefault() + stopPropagation() cancels the submit before both
         the browser AND htmx see it, so one guard covers native and boosted
         forms alike. --- */

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    var invalid = null;
    form.querySelectorAll('[data-json-input]').forEach(function (textarea) {
      if (invalid) return;
      var raw = textarea.value.trim();
      if (!raw) return;
      try {
        JSON.parse(raw);
      } catch (error) {
        invalid = textarea;
      }
    });
    if (invalid) {
      event.preventDefault();
      event.stopPropagation();
      invalid.focus();
      window.alert('JSON fields must contain valid JSON.');
      return;
    }

    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  /* ==================================================================== *
   *  htmx wiring
   * ==================================================================== */

  // The server renders meaningful bodies for error statuses: 400 form
  // re-renders swap into place, toast-only bodies arrive with HX-Reswap:none.
  // Let them through instead of dropping non-2xx responses.
  document.addEventListener('htmx:beforeSwap', function (event) {
    var status = event.detail.xhr ? event.detail.xhr.status : 0;
    if (status >= 400) {
      event.detail.shouldSwap = true;
      event.detail.isError = false;
    }
    rememberFocus(event.detail.target);
  });

  document.addEventListener('htmx:afterSwap', function (event) {
    var target = event.detail.target instanceof Element ? event.detail.target : null;
    if (!target) return;
    // outerHTML swaps detach the original target; re-resolve by id.
    var live = target.isConnected ? target : (target.id ? document.getElementById(target.id) : null);
    if (live) enhance(live);

    if (target.id === 'data-panel') {
      restoreFocus(live);
      return;
    }

    if (target.id === 'main' && live) {
      // Behave like a navigation: hand focus to the new content (or its
      // explicitly marked field) so keyboard and screen-reader users follow.
      var auto = live.querySelector('[autofocus]');
      var focusTarget = auto || live;
      if (typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
      }
      focusMemo = null;
    }
  });

  document.addEventListener('htmx:sendError', function () {
    showToast('Could not reach MantiFox. Check the network and retry.', 'error');
  });

  document.addEventListener('htmx:timeout', function () {
    showToast('The request timed out. Retry in a moment.', 'error');
  });

  // Don't resurrect stale toasts when navigating back to a cached page.
  document.addEventListener('htmx:beforeHistorySave', function () {
    var region = document.getElementById('toast-region');
    if (region) region.replaceChildren();
  });

  /* --- focus continuity for panel swaps (search box, per-page select) --- */

  var focusMemo = null;

  function rememberFocus(target) {
    focusMemo = null;
    var active = document.activeElement;
    if (!target || !(active instanceof Element)) return;
    if (target.contains(active) && active.name) {
      focusMemo = {
        name: active.name,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
      };
    }
  }

  function restoreFocus(container) {
    var memo = focusMemo;
    focusMemo = null;
    if (!container || !memo || !memo.name) return;
    var control = container.querySelector('[name="' + cssEscape(memo.name) + '"]');
    if (!control) return;
    control.focus({ preventScroll: true });
    if (memo.end !== null && typeof control.setSelectionRange === 'function') {
      var end = Math.min(memo.end, control.value.length);
      try {
        control.setSelectionRange(end, end);
      } catch (ignored) {
        /* not every input type supports selections */
      }
    }
  }

  /* ==================================================================== *
   *  Toasts (shared feedback region; server adds via OOB swaps, the
   *  observer below handles auto-dismiss for both origins)
   * ==================================================================== */

  var toastObserver = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node instanceof Element && node.classList.contains('toast')) {
          scheduleToastDismiss(node);
        }
      });
    });
  });

  function observeToasts() {
    // Observe through body: the toast region survives #main swaps but a
    // history restore replaces body children, so watching the region node
    // directly would go stale.
    toastObserver.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleToastDismiss(toast) {
    if (toast.dataset.dismissScheduled) return;
    toast.dataset.dismissScheduled = '1';
    var ttl = toast.classList.contains('alert-error') ? 9000
      : toast.classList.contains('alert-warning') ? 7000
      : 4500;
    window.setTimeout(function () {
      dismissToast(toast);
    }, ttl);
  }

  function dismissToast(toast) {
    if (!toast || !toast.isConnected) return;
    toast.classList.add('leaving');
    var removed = false;
    var remove = function () {
      if (removed) return;
      removed = true;
      toast.remove();
    };
    toast.addEventListener('animationend', remove, { once: true });
    window.setTimeout(remove, 400); // reduced-motion fallback
  }

  function showToast(message, type) {
    var region = document.getElementById('toast-region');
    if (!region) {
      window.alert(message);
      return;
    }
    var toast = document.createElement('div');
    toast.className = 'toast alert alert-' + (type || 'error');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('data-toast-close', '');
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    toast.append(text, close);
    region.prepend(toast);
  }

  /* ==================================================================== *
   *  Column builder row template (client-side only helper)
   * ==================================================================== */

  function createColumnRowHtml(index) {
    var prefix = 'col_' + index + '_';
    return '<div class="column-row" data-column-row>' +
      '<div class="column-row-main">' +
      '<label><span>Name</span><input name="' + prefix + 'name" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label>' +
      '<label><span>Type</span><select name="' + prefix + 'type" data-column-type>' +
      columnTypes().map(function (type) {
        return '<option value="' + type + '">' + type + '</option>';
      }).join('') +
      '</select></label>' +
      '<button type="button" class="secondary compact-remove" data-remove-column>Remove</button>' +
      '</div>' +
      '<div class="column-flags" data-column-kind>' +
      '<label class="checkbox-card column-modifier"><input type="checkbox" name="' + prefix + 'indexed" value="1" checked> <span>indexed</span></label>' +
      '<label class="checkbox-card column-modifier"><input type="checkbox" name="' + prefix + 'stored" value="1" checked> <span>stored</span></label>' +
      '<label class="checkbox-card column-modifier"><input type="checkbox" name="' + prefix + 'attribute" value="1"> <span>attribute</span></label>' +
      '<label class="checkbox-card json-option"><input type="checkbox" name="' + prefix + 'secondary_index" value="1"> <span>secondary_index=1</span></label>' +
      '<div class="vector-options">' +
      '<label><span>knn_type</span><input name="' + prefix + 'knn_type" value="hnsw"></label>' +
      '<label><span>knn_dims</span><input name="' + prefix + 'knn_dims" inputmode="numeric"></label>' +
      '<label><span>similarity</span><select name="' + prefix + 'hnsw_similarity"><option value="l2">l2</option><option value="ip">ip</option><option value="cosine">cosine</option></select></label>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function columnTypes() {
    return ['text', 'string', 'int', 'integer', 'bigint', 'float', 'bool', 'json', 'timestamp', 'multi', 'multi64', 'float_vector'];
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }
})();

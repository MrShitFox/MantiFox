(function () {
  document.addEventListener('DOMContentLoaded', function () {
    bindConfirmations();
    bindAuthFields();
    bindConnectionTests();
    bindSqlConsole();
  });

  function bindConfirmations() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        if (!window.confirm(form.getAttribute('data-confirm'))) {
          event.preventDefault();
        }
      });
    });
  }

  function bindAuthFields() {
    document.querySelectorAll('.connection-form').forEach(function (form) {
      var select = form.querySelector('[name="auth_type"]');
      if (!select) return;

      function update() {
        form.querySelectorAll('.auth-basic').forEach(function (node) {
          node.hidden = select.value !== 'basic';
        });
        form.querySelectorAll('.auth-bearer').forEach(function (node) {
          node.hidden = select.value !== 'bearer';
        });
      }

      select.addEventListener('change', update);
      update();
    });
  }

  function bindConnectionTests() {
    document.querySelectorAll('[data-test-connection]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var id = button.getAttribute('data-test-connection');
        var output = document.querySelector('[data-test-output="' + cssEscape(id) + '"]');
        button.disabled = true;
        setText(output, 'Testing...');

        try {
          var response = await fetch('/api/connections/' + encodeURIComponent(id) + '/test', {
            method: 'POST',
            headers: { Accept: 'application/json' }
          });
          var data = await response.json();
          if (!response.ok || !data.ok) {
            setText(output, messagesToText(data.messages) || data.error || 'Connection test failed');
            output.className = 'test-output error-text';
          } else {
            setText(output, 'OK');
            output.className = 'test-output success-text';
          }
        } catch (error) {
          setText(output, error.message);
          output.className = 'test-output error-text';
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function bindSqlConsole() {
    var form = document.querySelector('[data-sql-console]');
    if (!form) return;

    var connectionId = form.getAttribute('data-sql-console');
    var textarea = form.querySelector('[name="sql"]');
    var results = document.querySelector('[data-sql-results]');

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      clearNode(results);
      results.classList.remove('empty');
      results.textContent = 'Running...';

      try {
        var response = await fetch('/api/connections/' + encodeURIComponent(connectionId) + '/sql', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sql: textarea.value })
        });
        var data = await response.json();
        clearNode(results);

        if (!response.ok) {
          results.appendChild(alertNode(data.error || 'SQL request failed', 'error'));
          return;
        }

        renderResultSets(results, data.results || []);
      } catch (error) {
        clearNode(results);
        results.appendChild(alertNode(error.message, 'error'));
      }
    });
  }

  function renderResultSets(target, resultSets) {
    if (!resultSets.length) {
      target.appendChild(textBlock('No results.', 'empty'));
      return;
    }

    resultSets.forEach(function (resultSet, index) {
      var section = document.createElement('section');
      section.className = 'result-set';

      var header = document.createElement('header');
      header.className = 'result-heading';
      var title = document.createElement('h3');
      title.textContent = 'Result ' + (index + 1);
      var count = document.createElement('span');
      count.textContent = String(resultSet.total ?? (resultSet.data || []).length) + ' rows';
      header.append(title, count);
      section.appendChild(header);

      if (resultSet.error) section.appendChild(alertNode('Statement ' + (index + 1) + ': ' + resultSet.error, 'error'));
      if (resultSet.warning) section.appendChild(alertNode('Statement ' + (index + 1) + ': ' + resultSet.warning, 'warning'));

      var columns = getColumns(resultSet);
      var rows = Array.isArray(resultSet.data) ? resultSet.data : [];
      if (!columns.length) {
        section.appendChild(textBlock('No tabular data returned.', 'empty'));
      } else {
        section.appendChild(tableNode(columns, rows));
      }

      target.appendChild(section);
    });
  }

  function tableNode(columns, rows) {
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');

    columns.forEach(function (column) {
      var th = document.createElement('th');
      th.textContent = column;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    if (!rows.length) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.className = 'empty';
      emptyCell.colSpan = columns.length;
      emptyCell.textContent = 'No rows';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
    } else {
      rows.forEach(function (row) {
        var tr = document.createElement('tr');
        columns.forEach(function (column) {
          var td = document.createElement('td');
          var code = document.createElement('code');
          code.textContent = valueToText(row[column]);
          td.appendChild(code);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function getColumns(resultSet) {
    if (Array.isArray(resultSet.columns) && resultSet.columns.length) {
      return resultSet.columns.map(function (column) {
        return Object.keys(column || {})[0];
      }).filter(Boolean);
    }
    if (Array.isArray(resultSet.data) && resultSet.data[0]) {
      return Object.keys(resultSet.data[0]);
    }
    return [];
  }

  function alertNode(message, type) {
    var div = document.createElement('div');
    div.className = 'alert alert-' + (type || 'error');
    div.textContent = message;
    return div;
  }

  function textBlock(message, className) {
    var p = document.createElement('p');
    p.className = className || '';
    p.textContent = message;
    return p;
  }

  function messagesToText(messages) {
    if (!Array.isArray(messages) || !messages.length) return '';
    return messages.map(function (message) {
      return (message.statement ? 'Statement ' + message.statement + ': ' : '') + message.message;
    }).join('\n');
  }

  function valueToText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }
})();

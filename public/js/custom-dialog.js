// Shared in-app dialog used instead of the browser's native confirm()/prompt():
// native dialogs can be suppressed by browser settings/extensions and can't be
// styled to match the app.
//
// Usage:
//   const { confirmed, value } = await createModalDialog({
//     type: 'danger' | 'warning' | 'success' | 'info',
//     title: 'Delete video',
//     message: `Delete "${name}"? This cannot be undone.`,
//     icon: 'ti-trash',                              // optional, theme default otherwise
//     confirmText: 'Delete',
//     cancelText: 'Cancel',
//     confirmClass: 'bg-red-500 hover:bg-red-600',   // optional button override
//     hasInput: true,                                // prompt-style; value carries the text
//     inputValue: 'prefilled text'
//   });
//
// title, message and inputValue are inserted as plain text, never HTML, so
// user content (stream/video/channel names) cannot inject markup.
function createModalDialog(options) {
  const themes = {
    info: {
      icon: 'ti-info-circle', color: 'text-blue-600', bg: 'bg-blue-600/10',
      border: 'border-gray-600/50', button: 'bg-blue-600 hover:bg-blue-700', buttonIcon: 'ti-check'
    },
    danger: {
      icon: 'ti-alert-triangle', color: 'text-red-400', bg: 'bg-red-500/10',
      border: 'border-gray-600/50', button: 'bg-red-500 hover:bg-red-600', buttonIcon: 'ti-trash'
    },
    warning: {
      icon: 'ti-alert-triangle', color: 'text-yellow-400', bg: 'bg-yellow-500/10',
      border: 'border-yellow-500/50', button: 'bg-yellow-500 hover:bg-yellow-600', buttonIcon: 'ti-alert-circle'
    },
    success: {
      icon: 'ti-check-circle', color: 'text-green-400', bg: 'bg-green-500/10',
      border: 'border-green-500/50', button: 'bg-green-500 hover:bg-green-600', buttonIcon: 'ti-check'
    }
  };
  const theme = themes[options.type] || themes.info;

  const backdrop = document.createElement('div');
  backdrop.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all duration-300';

  const frame = document.createElement('div');
  frame.className = 'transform transition-all duration-300 opacity-0 scale-95 max-w-md w-full mx-4';
  frame.setAttribute('role', 'alertdialog');
  frame.setAttribute('aria-modal', 'true');
  frame.innerHTML = `
    <div class="bg-dark-800 rounded-lg shadow-xl border ${theme.border} overflow-hidden">
      <div class="px-6 py-5 flex items-center">
        <div class="w-12 h-12 rounded-full ${theme.bg} flex items-center justify-center mr-4 shrink-0">
          <i class="ti ${options.icon || theme.icon} ${theme.color} text-2xl"></i>
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-lg font-medium text-white dialog-title"></h3>
          <p class="text-gray-400 text-sm mt-1 dialog-message"></p>
        </div>
      </div>
      <div class="px-6 pb-4 hidden dialog-input-row">
        <input type="text" class="dialog-input w-full bg-dark-700 border border-gray-600 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">
      </div>
      <div class="px-6 py-4 flex justify-end space-x-3 border-t border-gray-600/50">
        <button type="button" class="dialog-cancel px-4 py-2.5 bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg transition-colors text-sm font-medium flex items-center">
          <i class="ti ti-x mr-1.5"></i><span class="dialog-cancel-text"></span>
        </button>
        <button type="button" class="dialog-confirm ${options.confirmClass || theme.button} px-4 py-2.5 text-white rounded-lg transition-colors text-sm font-medium flex items-center">
          <i class="ti ${theme.buttonIcon} mr-1.5"></i><span class="dialog-confirm-text"></span>
        </button>
      </div>
    </div>
  `;
  frame.querySelector('.dialog-title').textContent = options.title || '';
  frame.querySelector('.dialog-message').textContent = options.message || '';
  frame.querySelector('.dialog-cancel-text').textContent = options.cancelText || 'Cancel';
  frame.querySelector('.dialog-confirm-text').textContent = options.confirmText || 'Confirm';

  const input = frame.querySelector('.dialog-input');
  if (options.hasInput) {
    frame.querySelector('.dialog-input-row').classList.remove('hidden');
    input.value = options.inputValue || '';
  }

  backdrop.appendChild(frame);
  document.body.appendChild(backdrop);
  // counter instead of a plain toggle so stacked dialogs don't unlock page
  // scroll while one is still open
  window.__customDialogCount = (window.__customDialogCount || 0) + 1;
  document.body.classList.add('overflow-hidden');

  requestAnimationFrame(() => {
    frame.classList.replace('opacity-0', 'opacity-100');
    frame.classList.replace('scale-95', 'scale-100');
  });

  return new Promise((resolve) => {
    let closed = false;

    const close = (confirmed) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown);
      frame.classList.replace('opacity-100', 'opacity-0');
      frame.classList.replace('scale-100', 'scale-95');
      setTimeout(() => {
        window.__customDialogCount = Math.max(0, window.__customDialogCount - 1);
        if (window.__customDialogCount === 0) document.body.classList.remove('overflow-hidden');
        backdrop.remove();
        resolve({ confirmed, value: options.hasInput ? input.value : null });
      }, 200);
    };

    const onKeydown = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter' && options.hasInput) close(true);
    };

    frame.querySelector('.dialog-confirm').addEventListener('click', () => close(true));
    frame.querySelector('.dialog-cancel').addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKeydown);

    if (options.hasInput) {
      input.focus();
      input.select();
    } else if (options.type === 'danger') {
      // destructive actions default to Cancel so Enter/Space can't confirm
      // them by accident
      frame.querySelector('.dialog-cancel').focus();
    } else {
      frame.querySelector('.dialog-confirm').focus();
    }
  });
}

window.createModalDialog = createModalDialog;

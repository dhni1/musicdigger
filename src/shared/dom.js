function clearChildren(element) {
  if (element) {
    element.replaceChildren();
  }
}

function createElement(tagName, options = {}) {
  const {
    className = '',
    text = null,
    attributes = {},
  } = options;

  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (text !== null) {
    element.textContent = text;
  }

  Object.entries(attributes).forEach(([name, value]) => {
    if (value !== null && value !== undefined) {
      element.setAttribute(name, String(value));
    }
  });

  return element;
}

function createEmptyState(message, options = {}) {
  const {
    tagName = 'div',
    className = 'empty-state',
  } = options;

  return createElement(tagName, {
    className,
    text: message,
  });
}

function createTextBlock(tagName, text, className = '') {
  return createElement(tagName, { className, text });
}

function sanitizeHttpUrl(value) {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    return '';
  }

  return '';
}

function createExternalLink(href, text, className = '') {
  return createElement('a', {
    className,
    text,
    attributes: {
      href: sanitizeHttpUrl(href) || '#',
      target: '_blank',
      rel: 'noreferrer',
    },
  });
}

export {
  clearChildren,
  createElement,
  createEmptyState,
  createExternalLink,
  createTextBlock,
  sanitizeHttpUrl,
};

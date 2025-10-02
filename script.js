const yearSpan = document.getElementById('year');
if (yearSpan) {
  yearSpan.textContent = new Date().getFullYear().toString();
}

const WORKER_ENDPOINT = document.body?.dataset.workerEndpoint?.trim() ?? '';
const TURNSTILE_SITE_KEY = document.body?.dataset.turnstileSitekey?.trim() ?? '';

const formFieldMap = {
  family: {
    name: 'family-name',
    email: 'family-email',
    region: 'family-region',
    interest: 'family-interest',
  },
  donor: {
    name: 'donor-name',
    email: 'donor-email',
    focus: 'donor-focus',
    message: 'donor-message',
  },
  collaborator: {
    name: 'collab-name',
    email: 'collab-email',
    expertise: 'collab-expertise',
    idea: 'collab-idea',
  },
};

const widgetIds = new Map();
const submitLabels = new Map();

function findFeedbackElement(form) {
  return form.querySelector('.form-feedback');
}

function setFeedback(form, message, type) {
  const feedback = findFeedbackElement(form);
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.remove('form-feedback--success', 'form-feedback--error');
  if (type) {
    feedback.classList.add(type === 'success' ? 'form-feedback--success' : 'form-feedback--error');
  }
}

function toggleSubmittingState(form, submitting) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) {
    return;
  }
  if (!submitLabels.has(button)) {
    submitLabels.set(button, button.textContent ?? 'Submit');
  }
  button.disabled = submitting;
  button.textContent = submitting ? 'Submitting…' : submitLabels.get(button);
}

function collectFormValues(form, formType) {
  const fieldMap = formFieldMap[formType];
  const data = {};
  Object.entries(fieldMap).forEach(([key, name]) => {
    const value = form.elements.namedItem(name);
    if (value && 'value' in value) {
      data[key] = value.value.trim();
    } else {
      data[key] = '';
    }
  });
  return data;
}

function resetTurnstile(form) {
  const widgetId = widgetIds.get(form);
  if (widgetId && typeof window !== 'undefined' && window.turnstile) {
    window.turnstile.reset(widgetId);
  }
}

function ensureTurnstile() {
  if (typeof window === 'undefined') {
    return;
  }

  const attemptRender = () => {
    if (!window.turnstile) {
      window.setTimeout(attemptRender, 200);
      return;
    }

    window.turnstile.ready(() => {
      document.querySelectorAll('.pilot-form').forEach((form) => {
        if (!(form instanceof HTMLFormElement) || widgetIds.has(form)) {
          return;
        }
        const container = form.querySelector('.turnstile-container');
        if (!(container instanceof HTMLElement)) {
          return;
        }
        const widgetId = window.turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: () => {
            setFeedback(form, '', null);
          },
          'expired-callback': () => {
            setFeedback(form, 'Please complete the verification again.', 'error');
          },
          'error-callback': () => {
            setFeedback(form, 'Verification is unavailable. Please refresh and try again.', 'error');
          },
        });
        widgetIds.set(form, widgetId);
      });
    });
  };

  attemptRender();
}

document.addEventListener('DOMContentLoaded', () => {
  const forms = document.querySelectorAll('.pilot-form');
  forms.forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const formType = form.dataset.formType;
      if (!formType || !(formType in formFieldMap)) {
        setFeedback(form, 'Unsupported form type.', 'error');
        return;
      }

      if (!WORKER_ENDPOINT || WORKER_ENDPOINT.includes('your-worker-subdomain')) {
        setFeedback(form, 'Form submission is not configured yet. Please update the worker endpoint.', 'error');
        return;
      }

      if (!TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY.startsWith('0x000000')) {
        setFeedback(form, 'Turnstile is not configured. Please supply your site key.', 'error');
        return;
      }

      const widgetId = widgetIds.get(form);
      if (!widgetId || typeof window === 'undefined' || !window.turnstile) {
        setFeedback(form, 'Verification could not be loaded. Please refresh the page.', 'error');
        return;
      }

      const token = window.turnstile.getResponse(widgetId);
      if (!token) {
        setFeedback(form, 'Please complete the verification challenge.', 'error');
        return;
      }

      const payload = {
        formType,
        data: collectFormValues(form, formType),
        'cf-turnstile-response': token,
      };

      toggleSubmittingState(form, true);
      setFeedback(form, 'Submitting your details…', null);

      try {
        const response = await fetch(WORKER_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const result = await response.json().catch(() => ({}));

        if (response.ok && result && result.ok) {
          setFeedback(form, 'Thanks! We’ll be in touch soon.', 'success');
          form.reset();
        } else {
          const errorMessage = result?.error || 'We could not submit your request. Please try again.';
          setFeedback(form, errorMessage, 'error');
        }
      } catch (error) {
        setFeedback(form, 'Network error. Please try again in a moment.', 'error');
      } finally {
        toggleSubmittingState(form, false);
        resetTurnstile(form);
      }
    });
  });

  if (TURNSTILE_SITE_KEY && !TURNSTILE_SITE_KEY.startsWith('0x000000')) {
    ensureTurnstile();
  }
});

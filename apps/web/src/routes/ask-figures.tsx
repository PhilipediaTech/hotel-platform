import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import ownerStrings from '../i18n/en/owner.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(ownerStrings);

// Questions about the figures (PRD M14-12; T-116), answered from the open hotel's reports and
// naming them.

export function AskFigures() {
  const { t } = useTranslation();
  const { permissions, currentPropertyId } = useSession();
  const [question, setQuestion] = useState('');
  const ask = useMutation({
    mutationFn: () => api.call('askFigures', { body: { question } }),
  });
  if (!currentPropertyId || !permissions.includes('report.dashboard')) return null;
  const answer = ask.data;
  return (
    <section
      aria-labelledby="ask-figures"
      className="mt-6 max-w-2xl rounded-md border border-border bg-surface p-4"
    >
      <h2 id="ask-figures" className="font-semibold">
        {t('owner.ask.title')}
      </h2>
      <p className="text-sm text-text-muted">{t('owner.ask.hint')}</p>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) ask.mutate();
        }}
      >
        <Label htmlFor="ask-question">{t('owner.ask.label')}</Label>
        <textarea
          id="ask-question"
          maxLength={500}
          placeholder={t('owner.ask.example')}
          className="min-h-16 rounded-md border border-border bg-surface p-2 text-sm"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div>
          <Button type="submit" disabled={ask.isPending || question.trim().length < 3}>
            {ask.isPending ? t('owner.ask.thinking') : t('owner.ask.submit')}
          </Button>
        </div>
      </form>
      {ask.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(ask.error)}
        </Alert>
      )}
      {answer && (
        <div className="mt-3 text-sm">
          <p className="whitespace-pre-line">{answer.answer}</p>
          {answer.grounded ? (
            <p className="mt-1 text-text-muted">
              {t('owner.ask.source', {
                sources: answer.sources
                  .map((s) => (s.detail ? `${s.report} (${s.detail})` : s.report))
                  .join(', '),
              })}
            </p>
          ) : (
            <p className="mt-1 text-text-muted">{t('owner.ask.noReport')}</p>
          )}
        </div>
      )}
    </section>
  );
}

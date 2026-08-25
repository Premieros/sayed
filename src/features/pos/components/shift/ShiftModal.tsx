import { useState } from 'react';
import { Timer, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { formatCurrency } from '@/lib/format';
import * as api from '@/api';
import { useToast } from '@/components/Toast';

interface ShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchId?: string;
  activeShift: { id: string; expected: number; opened_at: string; opening_amount: number } | null;
  currency: string;
  onShiftClosed: () => void;
}

export function ShiftModal({
  isOpen,
  onClose,
  activeShift,
  currency,
  onShiftClosed,
}: ShiftModalProps) {
  const { t, lang } = useLanguage();
  const isAr = lang === 'ar';
  const { show } = useToast();

  const [closingCash, setClosingCash] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [closing, setClosing] = useState(false);

  if (!isOpen) return null;

  const expectedAmount = activeShift?.expected || activeShift?.opening_amount || 0;
  const actualAmount = typeof closingCash === 'number' ? closingCash : 0;
  const difference = typeof closingCash === 'number' ? actualAmount - expectedAmount : 0;

  const handleCloseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShift) return;
    if (typeof closingCash !== 'number') {
      show(isAr ? 'يرجى إدخال المبلغ الفعلي في الدرج' : 'Please enter actual cash counted', 'error');
      return;
    }

    setClosing(true);
    try {
      const { error } = await api.shifts.close({
        p_shift_id: activeShift.id,
        p_actual_amount: actualAmount,
        p_notes: notes.trim() || null,
      });

      if (error) throw error;

      show(isAr ? 'تم إغلاق الوردية بنجاح' : 'Shift closed successfully', 'success');
      onShiftClosed();
      onClose();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Error closing shift', 'error');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ui-text/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-ui-border bg-ui-surface shadow-ui-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-ui-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Timer className="h-5 w-5 text-ui-accent" />
            <h3 className="text-base font-black text-ui-text">
              {isAr ? 'إدارة وردية الكاشير' : 'Shift Management'}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label={isAr ? 'إغلاق' : 'Close'}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-ui-subtle hover:bg-ui-page-alt"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {activeShift ? (
            <form onSubmit={handleCloseShift} className="space-y-5">
              {/* Shift Stats Card */}
              <div className="rounded-2xl border border-ui-border bg-ui-page-alt p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-ui-muted">{isAr ? 'تاريخ الفتح' : 'Opened At'}</span>
                  <span className="font-black text-ui-text">
                    {new Date(activeShift.opened_at).toLocaleTimeString(isAr ? 'ar-EG' : 'en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-ui-muted">{isAr ? 'رصيد الافتتاح' : 'Opening Amount'}</span>
                  <span className="font-black text-ui-text">
                    {formatCurrency(activeShift.opening_amount, currency, lang)}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-ui-border/60 pt-2 text-sm">
                  <span className="font-black text-ui-text">{isAr ? 'المبلغ المتوقع بالدرج' : 'Expected Cash'}</span>
                  <span className="font-black text-ui-accent">
                    {formatCurrency(expectedAmount, currency, lang)}
                  </span>
                </div>
              </div>

              {/* Actual Cash Input */}
              <div>
                <label className="mb-2 block text-xs font-black text-ui-muted">
                  {isAr ? 'المبلغ الفعلي بالدرج (العد الفعلي) *' : 'Actual Cash in Drawer *'}
                </label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  required
                  value={closingCash}
                  onChange={(e) => setClosingCash(e.target.value === '' ? '' : parseFloat(e.target.value))}
                  placeholder="0.00"
                  className="h-14 w-full rounded-2xl border border-ui-border bg-ui-page-alt text-center text-2xl font-black text-ui-text outline-none focus:border-ui-primary focus:ring-2 focus:ring-ui-ring"
                />
              </div>

              {/* Live Difference Indicator */}
              {typeof closingCash === 'number' && (
                <div
                  className={`flex items-center justify-between rounded-2xl p-4 text-xs font-black ${
                    difference === 0
                      ? 'bg-ui-success/10 text-ui-success'
                      : difference > 0
                      ? 'bg-ui-info/10 text-ui-info'
                      : 'bg-ui-danger/10 text-ui-danger'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {difference === 0 ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    <span>
                      {difference === 0
                        ? isAr
                          ? 'الدرج متطابق تماماً'
                          : 'Drawer matches exactly'
                        : difference > 0
                        ? isAr
                          ? 'يوجد زيادة في الدرج'
                          : 'Cash Surplus'
                        : isAr
                        ? 'يوجد عجز في الدرج'
                        : 'Cash Shortage'}
                    </span>
                  </div>
                  <span>{formatCurrency(Math.abs(difference), currency, lang)}</span>
                </div>
              )}

              {/* Closing Notes */}
              <div>
                <label className="mb-1.5 block text-xs font-black text-ui-muted">
                  {isAr ? 'ملاحظات إغلاق الوردية' : 'Closing Notes'}
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={isAr ? 'أي ملاحظات أو توضيحات إضافية...' : 'Any closing remarks...'}
                  className="w-full rounded-xl border border-ui-border bg-ui-page-alt p-3 text-xs font-bold text-ui-text outline-none focus:border-ui-primary"
                />
              </div>

              {/* Submit Button */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-ui-border bg-ui-surface py-3 text-xs font-black text-ui-muted hover:bg-ui-page-alt"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={closing || typeof closingCash !== 'number'}
                  className="flex-1 rounded-xl bg-ui-danger py-3 text-xs font-black text-ui-primary-fg shadow-ui-md hover:bg-ui-danger/90 disabled:opacity-50"
                >
                  {closing ? (isAr ? 'جاري الإغلاق...' : 'Closing...') : (isAr ? 'إغلاق الوردية' : 'Close Shift')}
                </button>
              </div>
            </form>
          ) : (
            <div className="py-8 text-center text-ui-subtle">
              <Timer className="mx-auto mb-3 h-12 w-12 opacity-20" />
              <p className="text-sm font-bold">{isAr ? 'لا توجد وردية مفتوحة حالياً لهذا الفرع' : 'No open shift for this branch'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

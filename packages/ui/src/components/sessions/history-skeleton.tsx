/** A conversation's shape: what was asked on the right, the answer's lines on the left. */
const turns = [
  { id: 'first', asked: 'w-48', answer: { a: 'w-full', b: 'w-11/12', c: 'w-2/3' } },
  { id: 'second', asked: 'w-64', answer: { a: 'w-full', b: 'w-5/6', c: 'w-full', d: 'w-1/2' } },
  { id: 'third', asked: 'w-36', answer: { a: 'w-3/4', b: 'w-2/5' } },
];

/**
 * Where a conversation will be while it is read: its turns' outline, breathing, in the column
 * the messages take, so the first ones land where the eye already is.
 */
export function HistorySkeleton() {
  return (
    <div
      className="flex animate-pulse flex-col gap-9 py-6"
      role="status"
      aria-label="Loading conversation"
    >
      {turns.map((turn) => (
        <div key={turn.id} className="flex flex-col gap-5">
          <span className={`h-10 self-end rounded-2xl bg-ink/7 ${turn.asked}`} />
          <div className="flex flex-col gap-2.5">
            {Object.entries(turn.answer).map(([line, width]) => (
              <span key={line} className={`h-3 rounded-full bg-ink/7 ${width}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function VeoPageState({ title = 'Loading workspace', message = 'Loading…', error, onRetry }: { title?: string; message?: string; error?: string; onRetry?: () => void }) {
    return <section className="mx-auto w-full max-w-[1440px] rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p role={error ? 'alert' : 'status'} className="mt-2 text-sm leading-6 text-slate-500">{error || message}</p>
        {error ? onRetry && <button type="button" onClick={onRetry} className="btn mt-5">Try again</button> : <div aria-hidden="true" className="mt-6 grid animate-pulse gap-4 sm:grid-cols-3">{[0, 1, 2].map(item => <div key={item} className="h-24 rounded-lg bg-slate-100" />)}</div>}
    </section>;
}

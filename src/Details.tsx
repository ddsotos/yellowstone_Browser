export function Details({ onBack }: { onBack: () => void }) {
  return (
    <main className="details-page">
      <button type="button" className="text-button" onClick={onBack}>
        Back to game
      </button>
      <h1>Yellowstone Browser</h1>
      <section>
        <h2>Model</h2>
        <p>
          This build uses one bundled ONNX model:
          Board columns V1 6h snapshot epoch001. The same model is used for
          expert NPC turns and in-game move analysis.
        </p>
      </section>
      <section>
        <h2>Analysis</h2>
        <p>
          Analysis compares the current player&apos;s selected turn with the
          model&apos;s top legal turn candidates. Scores are estimated win
          probabilities for the player to move.
        </p>
      </section>
      <section>
        <h2>Privacy</h2>
        <p>
          Model inference runs in the browser. Saved local games stay in
          localStorage, and online play sends only game actions and lobby state
          to the local online server.
        </p>
      </section>
      <section>
        <h2>Credits</h2>
        <p>Original game design: Uwe Rosenberg / Publisher: AMIGO</p>
      </section>
    </main>
  );
}

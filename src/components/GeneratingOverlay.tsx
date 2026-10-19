export function GeneratingOverlay({ active }: { active: boolean }) {
  return (
    <div className={`generating-overlay${active ? ' active' : ''}`} id="generating-overlay">
      <div className="generating-content">
        <div className="generating-spinner"></div>
        <p className="generating-text">Writing drafts...</p>
        <p className="generating-subtext">Usually a few seconds.</p>
      </div>
    </div>
  );
}

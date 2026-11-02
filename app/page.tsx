import { LandingActions } from "@/components/landing-actions"

const repositoryUrl =
  process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim() ||
  "https://github.com/ydiallo/twitch_hackathon"

export default function LandingPage() {
  return (
    <main className="landing-page">
      <section className="landing-copy">
        <p className="landing-kicker">LIVE PRODUCER MODE</p>
        <h1>IRL Missions</h1>
        <p className="landing-tagline">
          Chat pitches the missions, you run the stream.
        </p>
        <LandingActions repositoryUrl={repositoryUrl} />
      </section>

      <section className="landing-showcase" aria-label="Stream overlay preview">
        <div className="show-card show-card--voting landing-preview-card">
          <p className="show-kicker">CHAT DECIDES</p>
          <h2 className="show-title">What happens next?</h2>
          <ol className="show-options">
            <li className="show-option--leader">
              <span>1</span>
              <b className="show-option-title">Street food speedrun</b>
              <em className="show-option-tag">WINNING</em>
              <strong className="show-option-votes">58%</strong>
            </li>
            <li>
              <span>2</span>
              <b className="show-option-title">Win Tic-Tac-Toe</b>
              <strong className="show-option-votes">27%</strong>
            </li>
            <li>
              <span>3</span>
              <b className="show-option-title">Find the city mascot</b>
              <strong className="show-option-votes">15%</strong>
            </li>
          </ol>
          <div className="show-live">
            <i /> VOTING LIVE
          </div>
        </div>
      </section>
    </main>
  )
}

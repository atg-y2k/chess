import { render } from 'preact';
import './styles/app.css';

function Placeholder() {
  return <p style="padding:24px">Chess Coach is being assembled…</p>;
}

render(<Placeholder />, document.getElementById('app')!);

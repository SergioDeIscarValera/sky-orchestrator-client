import { Card } from './Centered'
import { ALERT } from './styles'

export function StartupProblem({ problems }: { readonly problems: readonly string[] }) {
  return (
    <Card title="SOC cannot start">
      <p className="mt-2 text-sm">
        The web reads its Supabase address and public key from its configuration when its container
        starts, and refuses to run on one it cannot trust.
      </p>
      <ul role="alert" className={`${ALERT} mt-5 flex flex-col gap-1`}>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </Card>
  )
}

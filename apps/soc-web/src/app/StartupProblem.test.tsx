import { render, screen } from '@testing-library/react'

import { StartupProblem } from './StartupProblem'

describe('a refused start', () => {
  it('names every problem and nothing else to do', () => {
    render(<StartupProblem problems={['supabase_url: missing', 'supabase_key: missing']} />)
    expect(screen.getByRole('heading', { name: 'SOC cannot start' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'supabase_url: missing',
      'supabase_key: missing',
    ])
    expect(screen.queryByRole('button')).toBeNull()
  })
})

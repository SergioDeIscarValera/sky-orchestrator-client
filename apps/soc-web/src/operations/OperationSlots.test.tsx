import { render } from '@testing-library/react'

import { OperationActions } from './OperationActions'
import { OperationChecks } from './OperationChecks'
import { OperationLog } from './OperationLog'

describe("the detail's three slots, filled by another branch", () => {
  it('render nothing yet, so the detail is complete without them', () => {
    const { container } = render(
      <>
        <OperationChecks operationId="66666666-6666-4666-8666-666666666666" />
        <OperationActions operationId="66666666-6666-4666-8666-666666666666" />
        <OperationLog operationId="66666666-6666-4666-8666-666666666666" />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

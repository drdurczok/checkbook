import { ArrowRight, Building2, Landmark, Package, PiggyBank, TrendingUp, User, Zap } from 'lucide-react'
import { Modal } from './Modal'

/**
 * A static explainer of how the app models a household's finances: income flows
 * into the household, expenses flow out, and everything in between is grouped
 * into properties (with their utilities and contents), loans, savings and
 * investments.
 */
export function MoneyMapModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      className="quick-add-modal money-map-modal"
      eyebrow="How your money is organised"
      title="Money map"
      titleId="money-map-title"
      onClose={onClose}
    >
      <div className="money-map">
        <div className="money-map__flow money-map__flow--in">
          <span className="money-map__flow-label is-income">Income</span>
          <ArrowRight className="money-map__flow-arrow" />
        </div>

        <div className="money-map__household">
          <span className="money-map__person" aria-hidden="true"><User className="h-5 w-5" /></span>
          <span className="money-map__household-label">Household</span>

          <div className="money-map__grid">
            <section className="mm-box mm-box--properties">
              <header className="mm-box__head"><Building2 className="h-4 w-4" /> Properties</header>
              <div className="mm-subgrid">
                <div className="mm-box mm-box--utilities">
                  <span className="mm-box__head"><Zap className="h-4 w-4" /> Utilities</span>
                  <small>Recurring bills per property</small>
                </div>
                <div className="mm-box mm-box--contents">
                  <span className="mm-box__head"><Package className="h-4 w-4" /> Contents</span>
                  <small>Rooms, items &amp; projects</small>
                </div>
              </div>
            </section>

            <section className="mm-box mm-box--loans">
              <span className="mm-box__head"><Landmark className="h-4 w-4" /> Loans &amp; mortgages</span>
              <small>What you owe</small>
            </section>
            <section className="mm-box mm-box--savings">
              <span className="mm-box__head"><PiggyBank className="h-4 w-4" /> Savings</span>
              <small>Cash set aside</small>
            </section>
            <section className="mm-box mm-box--investments">
              <span className="mm-box__head"><TrendingUp className="h-4 w-4" /> Investments</span>
              <small>Assets that grow</small>
            </section>
          </div>
        </div>

        <div className="money-map__flow money-map__flow--out">
          <ArrowRight className="money-map__flow-arrow" />
          <span className="money-map__flow-label is-expenses">Expenses</span>
        </div>
      </div>

      <p className="money-map__caption">
        Income feeds your household; expenses flow out. Everything you own and owe is grouped so the
        Overview can show your true net worth — properties hold their own utilities and contents
        (including completed projects), while loans, savings and investments are tracked separately.
      </p>
    </Modal>
  )
}

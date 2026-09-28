import { cloudAgentLaunchSlots, resolveCloudAgentMaxConcurrent } from '../services/cloudAgentQueue';
import { queuePlaceLabel } from '../../shared/utils/queuePlace';

describe('cloud agent queue', () => {
  it('keeps eight containers running unless the environment sets a lower or higher cap', () => {
    expect(resolveCloudAgentMaxConcurrent(undefined)).toBe(8);
    expect(resolveCloudAgentMaxConcurrent('5')).toBe(5);
    expect(resolveCloudAgentMaxConcurrent('0')).toBe(8);
    expect(resolveCloudAgentMaxConcurrent('80')).toBe(50);
  });

  it('admits only the open slots when more runs are waiting', () => {
    expect(cloudAgentLaunchSlots(0, 8)).toBe(8);
    expect(cloudAgentLaunchSlots(8, 8)).toBe(0);
    expect(cloudAgentLaunchSlots(3, 8)).toBe(5);
  });

  it('labels a waiting run by its place in line', () => {
    expect(queuePlaceLabel(1)).toBe('1st in line');
    expect(queuePlaceLabel(2)).toBe('2nd in line');
    expect(queuePlaceLabel(3)).toBe('3rd in line');
    expect(queuePlaceLabel(11)).toBe('11th in line');
    expect(queuePlaceLabel(12)).toBe('12th in line');
    expect(queuePlaceLabel(13)).toBe('13th in line');
    expect(queuePlaceLabel(21)).toBe('21st in line');
  });
});

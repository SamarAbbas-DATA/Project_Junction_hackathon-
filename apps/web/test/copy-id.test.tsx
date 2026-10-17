import { describe,expect,it,vi } from 'vitest';
import { render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CopyId from '../src/components/ui/CopyId';

describe('copy identifier control',()=>{
  it('copies only the identifier and does not trigger the surrounding record action',async()=>{
    const user=userEvent.setup(),write=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue(),open=vi.fn();
    render(<div onClick={open} onKeyDown={open}><CopyId value="MB26101811501" label="culture ID"/></div>);
    const copy=screen.getByRole('button',{name:'Copy culture ID MB26101811501'});await user.hover(screen.getByText('MB26101811501'));await user.click(copy);
    expect(write).toHaveBeenCalledWith('MB26101811501');expect(open).not.toHaveBeenCalled();expect(await screen.findByText('Copied')).toBeTruthy();
    await user.keyboard('{Enter}');expect(open).not.toHaveBeenCalled();expect(write).toHaveBeenCalledTimes(2);write.mockRestore();
  });
  it('supports keyboard copying and clears success when the displayed ID changes',async()=>{
    const user=userEvent.setup(),write=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
    const view=render(<CopyId value="1018115" label="patient ID"/>);await user.tab();expect(document.activeElement).toBe(screen.getByRole('button',{name:'Copy patient ID 1018115'}));await user.keyboard(' ');await screen.findByText('Copied');
    view.rerender(<CopyId value="1018116" label="patient ID"/>);expect(screen.queryByText('Copied')).toBeNull();await user.click(screen.getByRole('button',{name:'Copy patient ID 1018116'}));expect(write).toHaveBeenLastCalledWith('1018116');write.mockRestore();
  });
  it('reports clipboard failure without pretending it copied',async()=>{
    const user=userEvent.setup(),write=vi.spyOn(navigator.clipboard,'writeText').mockRejectedValue(new Error('denied'));
    render(<CopyId value="MED-02" label="ward code"/>);await user.click(screen.getByRole('button',{name:'Copy ward code MED-02'}));
    await waitFor(()=>expect(screen.getByText('Select the ID to copy')).toBeTruthy());expect(screen.queryByText('Copied')).toBeNull();write.mockRestore();
  });
});
